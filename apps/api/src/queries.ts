// Query agregasi. Semua penjumlahan dikerjakan Postgres; periode sekarang & pembanding diambil
// dalam satu kali scan (SUM … FILTER). Hasilnya hanya beberapa baris per query.
import {
  type AdTotals, type SalesTotals, type LineCosts, type Line, type Kpis, type CampaignRow, type HourRow,
  type ProductRow, type Insight, type SeriesPoint, type DashboardResp, type CampaignsResp, type HourlyResp,
  type ProductsResp, type PlResp,
  computeKpis, div, recFor, LINES, rpk, dec, pct, eachDay, fmtDate, hourNow,
} from "@iklan/shared";
import { sql } from "./db";
import type { Config, Range, Scope } from "./scope";

const LINES_ALL: Line[] = ["digital", "jasa"];

interface RawTotals {
  cur: { ads: AdTotals[]; sales: SalesTotals[]; costs: LineCosts[] };
  prev: { ads: AdTotals[]; sales: SalesTotals[]; costs: LineCosts[] };
  otherItems: PlResp["otherItems"];
}

async function rawTotals(scope: Scope, r: Range, cfg: Config): Promise<RawTotals> {
  const lo = r.prevFrom < r.from ? r.prevFrom : r.from;
  const hi = r.prevTo > r.to ? r.prevTo : r.to;
  const ids = scope.accountIds;
  const lines = scope.lines;
  const salesAcc = scope.salesAccountId;

  // Biaya tetap per bulan dihitung prorata (÷30) hanya untuk hari yang beririsan dengan masa aktifnya (active_to inklusif).
  const overlap = (from: string, to: string) =>
    sql`GREATEST(0, LEAST(COALESCE(active_to, ${to}::date), ${to}::date) - GREATEST(active_from, ${from}::date) + 1)`;

  const [adRows, salesRows, costRows, otherItems, fixedRows] = await Promise.all([
    ids.length
      ? sql`
        SELECT account_id,
          COALESCE(sum(spend)          FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS spend,
          COALESCE(sum(impressions)    FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS impr,
          COALESCE(sum(clicks)         FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS clicks,
          COALESCE(sum(leads)          FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS leads,
          COALESCE(sum(purchases)      FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS purchases,
          COALESCE(sum(purchase_value) FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS meta_rev,
          COALESCE(sum(spend)          FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_spend,
          COALESCE(sum(impressions)    FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_impr,
          COALESCE(sum(clicks)         FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_clicks,
          COALESCE(sum(leads)          FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_leads,
          COALESCE(sum(purchases)      FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_purchases,
          COALESCE(sum(purchase_value) FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_meta_rev
        FROM campaign_daily
        WHERE account_id = ANY(${ids}) AND date BETWEEN ${lo} AND ${hi}
        GROUP BY account_id`
      : Promise.resolve([]),
    sql`
      SELECT s.line,
        COALESCE(sum(s.revenue) FILTER (WHERE s.date BETWEEN ${r.from} AND ${r.to}), 0) AS revenue,
        COALESCE(sum(s.qty)     FILTER (WHERE s.date BETWEEN ${r.from} AND ${r.to}), 0) AS orders,
        COALESCE(sum(COALESCE(s.gross, s.revenue)) FILTER (WHERE s.date BETWEEN ${r.from} AND ${r.to}), 0) AS fee_base,
        COALESCE(sum(COALESCE(s.cogs, p.cogs * s.qty, 0)) FILTER (WHERE s.date BETWEEN ${r.from} AND ${r.to}), 0) AS cogs,
        COALESCE(sum(s.revenue) FILTER (WHERE s.date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_revenue,
        COALESCE(sum(s.qty)     FILTER (WHERE s.date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_orders,
        COALESCE(sum(COALESCE(s.gross, s.revenue)) FILTER (WHERE s.date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_fee_base,
        COALESCE(sum(COALESCE(s.cogs, p.cogs * s.qty, 0)) FILTER (WHERE s.date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_cogs
      FROM sales s LEFT JOIN products p ON p.id = s.product_id
      WHERE s.deleted_at IS NULL AND s.line = ANY(${lines}::business_line[]) AND s.date BETWEEN ${lo} AND ${hi}
        AND (${salesAcc}::text IS NULL OR s.account_id = ${salesAcc})
      GROUP BY s.line`,
    sql`
      SELECT line,
        COALESCE(sum(amount) FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS other,
        COALESCE(sum(amount) FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_other
      FROM manual_costs
      WHERE deleted_at IS NULL AND line = ANY(${lines}::business_line[]) AND date BETWEEN ${lo} AND ${hi}
      GROUP BY line`,
    sql`
      SELECT id, date::text AS date, line, name, amount FROM manual_costs
      WHERE deleted_at IS NULL AND line = ANY(${lines}::business_line[]) AND date BETWEEN ${r.from} AND ${r.to}
      ORDER BY date, id LIMIT 50`,
    sql`
      SELECT line,
        COALESCE(sum(monthly * ${overlap(r.from, r.to)}), 0) / 30.0 AS fixed,
        COALESCE(sum(monthly * ${overlap(r.prevFrom, r.prevTo)}), 0) / 30.0 AS p_fixed
      FROM fixed_costs
      WHERE line = ANY(${lines}::business_line[]) AND active_from <= ${hi} AND (active_to IS NULL OR active_to >= ${lo})
      GROUP BY line`,
  ]);

  const accById = new Map(cfg.accounts.map((a) => [a.id, a]));
  const ad = (p: "" | "p_") => adRows.map((x) => {
    const a = accById.get(x.account_id)!;
    return {
      accountId: x.account_id, line: a.line, adTaxPct: a.settings.adTaxPct,
      spend: x[p + "spend"], impr: x[p + "impr"], clicks: x[p + "clicks"], leads: x[p + "leads"],
      purchases: x[p + "purchases"], metaRev: x[p + "meta_rev"],
    } as AdTotals;
  });
  const sales = (p: "" | "p_") => salesRows.map((x) => ({ line: x.line, revenue: x[p + "revenue"], orders: x[p + "orders"], cogs: x[p + "cogs"], feeBase: x[p + "fee_base"] }) as SalesTotals);
  const costs = (p: "" | "p_") => LINES_ALL.filter((l) => lines.includes(l)).map((line) => ({
    line,
    feePct: cfg.lineSettings.find((s) => s.line === line)?.feePct ?? 0,
    fixed: fixedRows.find((f) => f.line === line)?.[p + "fixed"] ?? 0,
    other: costRows.find((c) => c.line === line)?.[p + "other"] ?? 0,
  }));

  return {
    cur: { ads: ad(""), sales: sales(""), costs: costs("") },
    prev: { ads: ad("p_"), sales: sales("p_"), costs: costs("p_") },
    otherItems: otherItems.map((o) => ({ id: Number(o.id), date: o.date, line: o.line, name: o.name, amount: o.amount })),
  };
}

const kpisFor = (raw: RawTotals["cur"], lines: Line[], days: number) => computeKpis({ days, lines, ...raw });

/* ------------------------------------------------------------------ kampanye */

export async function campaigns(scope: Scope, r: Range): Promise<CampaignsResp> {
  const ids = scope.accountIds;
  if (!ids.length) return { rows: [], hasLeads: false, multiAccount: false, singleDay: r.days === 1 };
  const [rows, jasaSales] = await Promise.all([
    sql`
      WITH agg AS (
        SELECT campaign_id, sum(spend) AS spend, sum(impressions) AS impressions, sum(clicks) AS clicks,
               sum(leads) AS leads, sum(purchases) AS purchases, sum(purchase_value) AS revenue
        FROM campaign_daily
        WHERE account_id = ANY(${ids}) AND date BETWEEN ${r.from} AND ${r.to}
        GROUP BY campaign_id
      )
      SELECT c.id, c.name, c.account_id, c.status, c.effective_status, c.daily_budget,
             COALESCE(agg.spend, 0) AS spend, COALESCE(agg.impressions, 0) AS impressions, COALESCE(agg.clicks, 0) AS clicks,
             COALESCE(agg.leads, 0) AS leads, COALESCE(agg.purchases, 0) AS purchases, COALESCE(agg.revenue, 0) AS revenue
      FROM campaigns c LEFT JOIN agg ON agg.campaign_id = c.id
      WHERE c.account_id = ANY(${ids}) AND (agg.campaign_id IS NOT NULL OR c.status = 'ACTIVE')
      ORDER BY spend DESC, c.id`,
    // Omzet & closing jasa per akun → estimasi nilai per lead untuk kampanye jasa (lynk/manual tidak tahu kampanyenya).
    sql`
      SELECT account_id, sum(revenue) AS revenue, sum(qty) AS orders FROM sales
      WHERE deleted_at IS NULL AND line = 'jasa' AND account_id = ANY(${ids}) AND date BETWEEN ${r.from} AND ${r.to}
      GROUP BY account_id`,
  ]);
  const accById = new Map(scope.accounts.map((a) => [a.id, a]));
  const leadsByAcc = new Map<string, number>();
  for (const x of rows) leadsByAcc.set(x.account_id, (leadsByAcc.get(x.account_id) ?? 0) + x.leads);

  const out: CampaignRow[] = rows.map((x) => {
    const a = accById.get(x.account_id)!;
    const jasa = a.line === "jasa";
    let revenue = x.revenue, purchases = x.purchases;
    if (jasa) {
      const js = jasaSales.find((s) => s.account_id === x.account_id);
      const accLeads = leadsByAcc.get(x.account_id) ?? 0;
      revenue = Math.round(x.leads * div(js?.revenue ?? 0, accLeads));
      purchases = Math.round(x.leads * div(js?.orders ?? 0, accLeads));
    }
    const status = x.status === "ACTIVE" && x.effective_status !== "CAMPAIGN_PAUSED" ? "ACTIVE" : x.status;
    return {
      id: x.id, name: x.name, accountId: x.account_id, accountName: a.name, line: a.line, status,
      dailyBudget: x.daily_budget, spend: x.spend, impressions: x.impressions, clicks: x.clicks, leads: x.leads,
      purchases, revenue, revenueEstimated: jasa,
      ctr: div(x.clicks, x.impressions), cpc: div(x.spend, x.clicks),
      cpl: x.leads ? x.spend / x.leads : null, cpa: purchases ? x.spend / purchases : null, roas: div(revenue, x.spend),
      rec: recFor({ status, spend: x.spend, purchases, leads: x.leads, revenue }, a.line, a.settings),
    };
  });
  return {
    rows: out,
    hasLeads: out.some((c) => c.line === "jasa"),
    multiAccount: scope.accounts.length > 1,
    singleDay: r.days === 1,
  };
}

/* ------------------------------------------------------------------ per jam */

async function hourlyRows(ids: string[], r: Range) {
  if (!ids.length) return [];
  return sql`
    SELECT hour, sum(spend) AS spend, sum(clicks) AS clicks, sum(leads) AS leads, sum(purchases) AS purchases
    FROM account_hourly
    WHERE account_id = ANY(${ids}) AND date BETWEEN ${r.from} AND ${r.to}
    GROUP BY hour ORDER BY hour`;
}

export async function hourly(scope: Scope, r: Range): Promise<HourlyResp> {
  const rows = await hourlyRows(scope.accountIds, r);
  const hasDigital = scope.accounts.some((a) => a.line === "digital");
  const hasLeads = scope.accounts.some((a) => a.line === "jasa");
  const metric = hasLeads && !hasDigital ? "leads" : "purchases";
  const hours: HourRow[] = Array.from({ length: 24 }, (_, h) => {
    const x = rows.find((y) => y.hour === h);
    const spend = x?.spend ?? 0, res = x?.[metric] ?? 0;
    return { hour: h, spend, clicks: x?.clicks ?? 0, leads: x?.leads ?? 0, purchases: x?.purchases ?? 0, results: res, cost: res ? spend / res : null };
  });
  const best = hours.filter((h) => h.results > 0).sort((a, b) => a.cost! - b.cost!).slice(0, 5);
  const worst = hours.filter((h) => h.spend > 0)
    .sort((a, b) => (b.cost ?? b.spend * 1e4) - (a.cost ?? a.spend * 1e4)).slice(0, 5);
  return { metric, hours, best, worst, hasLeads, hasDigital };
}

/* ------------------------------------------------------------------ produk */

export async function products(scope: Scope, r: Range): Promise<ProductsResp> {
  const rows = await sql`
    SELECT s.line, s.product_id, COALESCE(p.name, s.product_name) AS name, p.url, p.price,
           sum(s.qty) AS qty, sum(s.revenue) AS revenue, sum(COALESCE(s.cogs, p.cogs * s.qty, 0)) AS cogs
    FROM sales s LEFT JOIN products p ON p.id = s.product_id
    WHERE s.deleted_at IS NULL AND s.line = ANY(${scope.lines}::business_line[]) AND s.date BETWEEN ${r.from} AND ${r.to}
      AND (${scope.salesAccountId}::text IS NULL OR s.account_id = ${scope.salesAccountId})
    GROUP BY s.line, s.product_id, COALESCE(p.name, s.product_name), p.url, p.price
    ORDER BY revenue DESC, name
    LIMIT 100`;
  const total = rows.reduce<{ qty: number; revenue: number; cogs: number }>((t, x) => ({ qty: t.qty + x.qty, revenue: t.revenue + x.revenue, cogs: t.cogs + x.cogs }), { qty: 0, revenue: 0, cogs: 0 });
  return {
    rows: rows.map((x): ProductRow => ({
      key: `${x.line}|${x.product_id ?? x.name}`, name: x.name, line: x.line, url: x.url,
      price: x.price ?? div(x.revenue, x.qty), qty: x.qty, revenue: x.revenue, cogs: x.cogs, share: div(x.revenue, total.revenue),
    })),
    total,
  };
}

/* ------------------------------------------------------------------ ringkasan */

async function series(scope: Scope, r: Range): Promise<DashboardResp["series"]> {
  const ids = scope.accountIds;
  const salesAcc = scope.salesAccountId;
  if (r.days === 1) {
    const [hrs, sales] = await Promise.all([
      hourlyRows(ids, r),
      sql`
        SELECT extract(hour FROM occurred_at AT TIME ZONE 'Asia/Jakarta')::int AS hour, sum(revenue) AS revenue
        FROM sales
        WHERE deleted_at IS NULL AND line = ANY(${scope.lines}::business_line[]) AND date = ${r.from}
          AND (${salesAcc}::text IS NULL OR account_id = ${salesAcc})
        GROUP BY 1`,
    ]);
    const lastHour = r.from === r.today ? hourNow() : 23;
    const points: SeriesPoint[] = Array.from({ length: lastHour + 1 }, (_, h) => {
      const x = hrs.find((y) => y.hour === h), s = sales.find((y) => y.hour === h);
      const spend = x?.spend ?? 0, revenue = s?.revenue ?? 0;
      return { label: String(h).padStart(2, "0"), spend, revenue, roas: div(revenue, spend), results: x?.purchases ?? 0, leads: x?.leads ?? 0 };
    });
    return { granularity: "hour", points };
  }
  const [ads, sales] = await Promise.all([
    ids.length
      ? sql`
        SELECT date::text AS date, sum(spend) AS spend, sum(purchases) AS purchases, sum(leads) AS leads
        FROM campaign_daily WHERE account_id = ANY(${ids}) AND date BETWEEN ${r.from} AND ${r.to}
        GROUP BY date`
      : Promise.resolve([]),
    sql`
      SELECT date::text AS date, sum(revenue) AS revenue FROM sales
      WHERE deleted_at IS NULL AND line = ANY(${scope.lines}::business_line[]) AND date BETWEEN ${r.from} AND ${r.to}
        AND (${salesAcc}::text IS NULL OR account_id = ${salesAcc})
      GROUP BY date`,
  ]);
  const adMap = new Map(ads.map((x) => [x.date, x]));
  const saleMap = new Map(sales.map((x) => [x.date, x.revenue as number]));
  const points = eachDay(r.from, r.to).map((d): SeriesPoint => {
    const a = adMap.get(d), spend = a?.spend ?? 0, revenue = saleMap.get(d) ?? 0;
    return { label: fmtDate(d, false), spend, revenue, roas: div(revenue, spend), results: a?.purchases ?? 0, leads: a?.leads ?? 0 };
  });
  return { granularity: "day", points };
}

export async function dashboard(scope: Scope, r: Range, cfg: Config): Promise<DashboardResp> {
  const [raw, ser, camp, status] = await Promise.all([
    rawTotals(scope, r, cfg),
    series(scope, r),
    campaigns(scope, r),
    scope.accountIds.length
      ? sql`
        SELECT count(*) FILTER (WHERE status = 'ACTIVE')::int AS active, count(*) FILTER (WHERE status = 'PAUSED')::int AS paused
        FROM campaigns WHERE account_id = ANY(${scope.accountIds})`
      : Promise.resolve([{ active: 0, paused: 0 }]),
  ]);
  const k = kpisFor(raw.cur, scope.lines, r.days);
  const p = kpisFor(raw.prev, scope.lines, r.days);

  const ins: Insight[] = [];
  if (!k.spend && !k.revenue) ins.push({ tone: "info", title: "Belum ada data", text: "Tidak ada spend atau penjualan di periode ini." });
  else if (k.revenue === 0 && k.spend > 0)
    ins.push({ tone: "warn", title: "Omzet riil belum tercatat", text: `Belum ada penjualan lynk.id / input jasa di periode ini, jadi laba bersih belum bisa dihitung${k.metaRev ? ` (Meta melaporkan ${k.results} pembelian senilai ${rpk(k.metaRev)}, ROAS Meta ${dec(k.metaRoas)}x)` : ""}. Pasang webhook lynk.id supaya omzet masuk otomatis.` });
  else if (k.net < 0) ins.push({ tone: "bad", title: "Masih rugi", text: `Laba bersih ${rpk(k.net)}. ROAS riil perlu naik ke ${dec(k.beRoas)}x untuk impas.` });
  else ins.push({ tone: "good", title: "Profit", text: `Untung ${rpk(k.net)}${k.orders ? ` atau ${rpk(k.profitPerOrder)} per order` : ""}.` });
  if (p.spend) {
    const dS = div(k.spend - p.spend, p.spend), dN = k.net - p.net;
    ins.push({ tone: dN >= 0 ? "good" : "warn", title: "Dibanding periode lalu", text: `Spend ${dS >= 0 ? "naik" : "turun"} ${pct(Math.abs(dS))}, laba ${dN >= 0 ? "naik" : "turun"} ${rpk(Math.abs(dN))}.` });
  }
  const digitalAds = raw.cur.ads.filter((a) => a.line === "digital" && a.spend);
  if (digitalAds.length && scope.lines.includes("digital")) {
    const spend = digitalAds.reduce((t, a) => t + a.spend, 0), metaRev = digitalAds.reduce((t, a) => t + a.metaRev, 0);
    const realRev = raw.cur.sales.find((s) => s.line === "digital")?.revenue ?? 0;
    if (realRev > 0 && div(metaRev, spend) - div(realRev, spend) > 0.3)
      ins.push({ tone: "warn", title: "Meta lapor lebih tinggi", text: `ROAS Meta ${dec(div(metaRev, spend))}x vs riil ${dec(div(realRev, spend))}x. Cek pixel / atribusi.` });
  }
  for (const a of raw.cur.ads.filter((x) => x.line === "jasa" && x.leads)) {
    const acc = cfg.accounts.find((y) => y.id === a.accountId)!;
    const cpl = div(a.spend, a.leads);
    if (acc.settings.maxCpl && cpl > acc.settings.maxCpl)
      ins.push({ tone: "warn", title: "CPL jasa kemahalan", text: `${acc.name}: CPL ${rpk(cpl)}, batas ${rpk(acc.settings.maxCpl)}.` });
  }
  const best = camp.rows.filter((c) => c.status === "ACTIVE" && c.spend > 0).sort((a, b) => b.roas - a.roas)[0];
  if (best) ins.push({ tone: "info", title: "Kampanye terbaik", text: `${best.name} ROAS ${dec(best.roas)}x${best.revenueEstimated ? " (estimasi)" : ""}.` });

  const targets = scope.accounts.map((a) => a.settings.targetRoas);
  return {
    range: { from: r.from, to: r.to, prevFrom: r.prevFrom, prevTo: r.prevTo, days: r.days },
    scope: {
      lines: scope.lines, accountIds: scope.accountIds,
      hasLeads: scope.accounts.some((a) => a.line === "jasa"), hasDigital: scope.accounts.some((a) => a.line === "digital") || scope.lines.includes("digital"),
    },
    kpis: k, prev: p, series: ser, insights: ins.slice(0, 5),
    revenueByLine: LINES_ALL.filter((l) => scope.lines.includes(l)).map((line) => ({ line, revenue: raw.cur.sales.find((s) => s.line === line)?.revenue ?? 0 })),
    campaignStatus: status[0] as { active: number; paused: number },
    targetRoas: targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : 2.5,
  };
}

/* ------------------------------------------------------------------ laba rugi */

export async function pl(r: Range, cfg: Config): Promise<PlResp> {
  const active = cfg.accounts.filter((a) => a.active);
  const scope: Scope = { acc: "all", accounts: active, accountIds: active.map((a) => a.id), lines: LINES_ALL, salesAccountId: null };
  const raw = await rawTotals(scope, r, cfg);
  const col = (key: Line | "total") => {
    const lines = key === "total" ? LINES_ALL : [key];
    const k: Kpis = kpisFor(raw.cur, lines, r.days);
    const pk = kpisFor(raw.prev, lines, r.days);
    const hasPrev = pk.spend || pk.revenue;
    return {
      key, label: key === "total" ? "Gabungan" : LINES[key].label, src: key === "total" ? "Semua lini" : LINES[key].src,
      kpis: k, prevNet: hasPrev ? pk.net : null,
    };
  };
  return {
    range: { from: r.from, to: r.to, prevFrom: r.prevFrom, prevTo: r.prevTo, days: r.days },
    columns: [col("digital"), col("jasa"), col("total")],
    otherItems: raw.otherItems,
  };
}

/** Ringkasan teks untuk konteks bot. */
export async function summaryFor(scope: Scope, r: Range, cfg: Config) {
  const raw = await rawTotals(scope, r, cfg);
  return { kpis: kpisFor(raw.cur, scope.lines, r.days), prev: kpisFor(raw.prev, scope.lines, r.days) };
}
