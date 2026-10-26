// Statistik untuk tab "Facebook Ads" (data Meta) dan "lynk.id" (penjualan webhook). Semua agregasi di Postgres.
import { div, eachDay, fmtDate, hourNow, type FbResp, type FbKpis, type FbPoint, type LynkResp, type LynkKpis } from "@iklan/shared";
import { sql } from "./db";
import { lynkConfigured } from "./env";
import { campaigns } from "./queries";
import type { Config, Range, Scope } from "./scope";

/* ------------------------------------------------------------------ Facebook Ads */

const fbKpis = (x: { spend: number; adTax: number; impressions: number; clicks: number; purchases: number; purchaseValue: number; leads: number }): FbKpis => ({
  ...x, totalSpend: x.spend + x.adTax,
  ctr: div(x.clicks, x.impressions), cpc: div(x.spend, x.clicks), cpm: div(x.spend * 1000, x.impressions),
  roas: div(x.purchaseValue, x.spend), cpa: div(x.spend, x.purchases), cpl: div(x.spend, x.leads),
});
const ZERO_FB = { spend: 0, adTax: 0, impressions: 0, clicks: 0, purchases: 0, purchaseValue: 0, leads: 0 };

export async function fbAds(scope: Scope, r: Range): Promise<FbResp> {
  const ids = scope.accountIds;
  const range = { from: r.from, to: r.to, prevFrom: r.prevFrom, prevTo: r.prevTo, days: r.days };
  const flags = { hasLeads: scope.accounts.some((a) => a.line === "jasa"), hasDigital: scope.accounts.some((a) => a.line === "digital") };
  const granularity = r.days === 1 ? ("hour" as const) : ("day" as const);
  const defaultTaxPct = scope.accounts[0]?.settings.adTaxPct ?? 3;
  if (!ids.length) return { range, kpis: fbKpis(ZERO_FB), prev: fbKpis(ZERO_FB), adTaxPct: defaultTaxPct, series: { granularity, points: [] }, accounts: [], campaigns: [], ...flags, lastSyncedAt: null };
  const lo = r.prevFrom < r.from ? r.prevFrom : r.from, hi = r.prevTo > r.to ? r.prevTo : r.to;
  const [perAcc, ser, camp] = await Promise.all([
    sql`
      SELECT
        account_id,
        COALESCE(sum(spend) FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS spend,
        COALESCE(sum(impressions) FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS impressions,
        COALESCE(sum(clicks) FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS clicks,
        COALESCE(sum(purchases) FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS purchases,
        COALESCE(sum(purchase_value) FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS purchase_value,
        COALESCE(sum(leads) FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS leads,
        COALESCE(sum(spend) FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_spend,
        COALESCE(sum(impressions) FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_impressions,
        COALESCE(sum(clicks) FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_clicks,
        COALESCE(sum(purchases) FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_purchases,
        COALESCE(sum(purchase_value) FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_purchase_value,
        COALESCE(sum(leads) FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_leads
      FROM campaign_daily WHERE account_id = ANY(${ids}) AND date BETWEEN ${lo} AND ${hi}
      GROUP BY account_id`,
    r.days === 1
      ? sql`SELECT hour::text AS label, sum(spend) AS spend, sum(impressions) AS impressions, sum(clicks) AS clicks, sum(purchases) AS purchases, 0 AS purchase_value, sum(leads) AS leads
            FROM account_hourly WHERE account_id = ANY(${ids}) AND date = ${r.from} GROUP BY hour`
      : sql`SELECT date::text AS label, sum(spend) AS spend, sum(impressions) AS impressions, sum(clicks) AS clicks, sum(purchases) AS purchases, sum(purchase_value) AS purchase_value, sum(leads) AS leads
            FROM campaign_daily WHERE account_id = ANY(${ids}) AND date BETWEEN ${r.from} AND ${r.to} GROUP BY date`,
    campaigns(scope, r),
  ]);
  const taxMap = new Map(scope.accounts.map((a) => [a.id, a.settings.adTaxPct]));
  const sumAcc = (prefix: "" | "p_") => {
    let spend = 0, adTax = 0, impressions = 0, clicks = 0, purchases = 0, purchaseValue = 0, leads = 0;
    for (const x of perAcc) {
      const s = Number(x[prefix + "spend"] ?? 0);
      const pct = taxMap.get(x.account_id as string) ?? defaultTaxPct;
      spend += s;
      adTax += Math.round((s * pct) / 100);
      impressions += Number(x[prefix + "impressions"] ?? 0);
      clicks += Number(x[prefix + "clicks"] ?? 0);
      purchases += Number(x[prefix + "purchases"] ?? 0);
      purchaseValue += Number(x[prefix + "purchase_value"] ?? 0);
      leads += Number(x[prefix + "leads"] ?? 0);
    }
    return { spend, adTax, impressions, clicks, purchases, purchaseValue, leads };
  };
  const kpis = fbKpis(sumAcc(""));
  const prev = fbKpis(sumAcc("p_"));
  const adTaxPct = kpis.spend ? Math.round((kpis.adTax / kpis.spend) * 1000) / 10 : defaultTaxPct;
  const row = (x: any) => ({ spend: Number(x?.spend ?? 0), impressions: Number(x?.impressions ?? 0), clicks: Number(x?.clicks ?? 0), purchases: Number(x?.purchases ?? 0), purchaseValue: Number(x?.purchase_value ?? 0), leads: Number(x?.leads ?? 0) });
  let points: FbPoint[];
  if (granularity === "hour") {
    const lastHour = r.from === r.today ? hourNow() : 23;
    points = Array.from({ length: lastHour + 1 }, (_, h) => ({ label: String(h).padStart(2, "0"), ...row(ser.find((y) => y.label === String(h))) }));
  } else {
    const map = new Map(ser.map((x) => [x.label as string, x]));
    points = eachDay(r.from, r.to).map((d) => ({ label: fmtDate(d, false), ...row(map.get(d)) }));
  }
  const accounts = scope.accounts.map((a) => {
    const v = row(perAcc.find((y) => y.account_id === a.id));
    const adTax = Math.round((v.spend * a.settings.adTaxPct) / 100);
    return { id: a.id, name: a.name, line: a.line, ...v, adTax, adTaxPct: a.settings.adTaxPct, roas: div(v.purchaseValue, v.spend) };
  }).sort((a, b) => b.spend - a.spend);
  const last = scope.accounts.map((a) => a.lastSyncedAt).filter((x): x is string => !!x).sort().reverse()[0] ?? null;
  return { range, kpis, prev, adTaxPct, series: { granularity, points }, accounts, campaigns: camp.rows.slice(0, 10), ...flags, lastSyncedAt: last };
}

/* ------------------------------------------------------------------ lynk.id */

export async function lynkStats(r: Range, cfg: Config): Promise<LynkResp> {
  const ppnPct = cfg.lineSettings.find((l) => l.line === "digital")?.feePct ?? 0;
  const lo = r.prevFrom < r.from ? r.prevFrom : r.from, hi = r.prevTo > r.to ? r.prevTo : r.to;
  const granularity = r.days === 1 ? ("hour" as const) : ("day" as const);
  const [tot, ser, hrs, prods, recent, wh] = await Promise.all([
    sql`
      SELECT
        COALESCE(sum(revenue) FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS revenue,
        COALESCE(sum(COALESCE(gross, revenue)) FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS gross,
        COALESCE(count(DISTINCT lynk_ref_id) FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS orders,
        COALESCE(sum(qty) FILTER (WHERE date BETWEEN ${r.from} AND ${r.to}), 0) AS items,
        COALESCE(sum(revenue) FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_revenue,
        COALESCE(sum(COALESCE(gross, revenue)) FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_gross,
        COALESCE(count(DISTINCT lynk_ref_id) FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_orders,
        COALESCE(sum(qty) FILTER (WHERE date BETWEEN ${r.prevFrom} AND ${r.prevTo}), 0) AS p_items
      FROM sales WHERE channel = 'lynk' AND deleted_at IS NULL AND date BETWEEN ${lo} AND ${hi}`,
    r.days === 1
      ? sql`SELECT extract(hour FROM occurred_at AT TIME ZONE 'Asia/Jakarta')::int::text AS label, count(DISTINCT lynk_ref_id) AS orders, sum(revenue) AS revenue, sum(COALESCE(gross, revenue)) AS gross
            FROM sales WHERE channel = 'lynk' AND deleted_at IS NULL AND date = ${r.from} GROUP BY 1`
      : sql`SELECT date::text AS label, count(DISTINCT lynk_ref_id) AS orders, sum(revenue) AS revenue, sum(COALESCE(gross, revenue)) AS gross
            FROM sales WHERE channel = 'lynk' AND deleted_at IS NULL AND date BETWEEN ${r.from} AND ${r.to} GROUP BY date`,
    sql`SELECT extract(hour FROM occurred_at AT TIME ZONE 'Asia/Jakarta')::int AS hour, count(DISTINCT lynk_ref_id) AS orders, sum(revenue) AS revenue
        FROM sales WHERE channel = 'lynk' AND deleted_at IS NULL AND date BETWEEN ${r.from} AND ${r.to} GROUP BY 1`,
    sql`SELECT COALESCE(p.name, s.product_name) AS name, sum(s.qty) AS qty, sum(s.revenue) AS revenue
        FROM sales s LEFT JOIN products p ON p.id = s.product_id
        WHERE s.channel = 'lynk' AND s.deleted_at IS NULL AND s.date BETWEEN ${r.from} AND ${r.to}
        GROUP BY 1 ORDER BY revenue DESC, name LIMIT 8`,
    sql`SELECT occurred_at, product_name, qty, revenue FROM sales WHERE channel = 'lynk' AND deleted_at IS NULL ORDER BY occurred_at DESC, id DESC LIMIT 10`,
    sql`SELECT count(*)::int AS events, count(*) FILTER (WHERE signature_ok)::int AS valid, max(received_at) FILTER (WHERE signature_ok) AS last_at FROM lynk_events`,
  ]);
  const kp = (p: "" | "p_"): LynkKpis => {
    const t = tot[0], revenue = t[p + "revenue"], gross = t[p + "gross"], orders = t[p + "orders"];
    const ppn = (gross * ppnPct) / 100, net = revenue - ppn;
    return { orders, items: t[p + "items"], gross, discount: Math.max(0, gross - revenue), revenue, ppn, net, aov: div(net, orders) };
  };
  const netOf = (x: any) => (x ? x.revenue - (x.gross * ppnPct) / 100 : 0);
  let points: LynkResp["series"]["points"];
  if (granularity === "hour") {
    const lastHour = r.from === r.today ? hourNow() : 23;
    points = Array.from({ length: lastHour + 1 }, (_, h) => { const x = ser.find((y) => y.label === String(h)); return { label: String(h).padStart(2, "0"), orders: x?.orders ?? 0, net: netOf(x) }; });
  } else {
    const map = new Map(ser.map((x) => [x.label as string, x]));
    points = eachDay(r.from, r.to).map((d) => { const x = map.get(d); return { label: fmtDate(d, false), orders: x?.orders ?? 0, net: netOf(x) }; });
  }
  const allRev = tot[0].revenue;
  return {
    range: { from: r.from, to: r.to, prevFrom: r.prevFrom, prevTo: r.prevTo, days: r.days },
    kpis: kp(""), prev: kp("p_"), ppnPct,
    series: { granularity, points },
    hours: Array.from({ length: 24 }, (_, h) => { const x = hrs.find((y) => y.hour === h); return { hour: h, orders: x?.orders ?? 0, revenue: x?.revenue ?? 0 }; }),
    products: prods.map((x) => ({ name: x.name, qty: x.qty, revenue: x.revenue, share: div(x.revenue, allRev) })),
    recent: recent.map((x) => ({ at: x.occurred_at.toISOString(), product: x.product_name, qty: x.qty, revenue: x.revenue })),
    webhook: { configured: lynkConfigured(), events: wh[0].events, valid: wh[0].valid, invalid: wh[0].events - wh[0].valid, lastAt: wh[0].last_at?.toISOString() ?? null },
  };
}
