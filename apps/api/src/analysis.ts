// Analisis tajam untuk bot: dekomposisi funnel (CPA = CPM ÷ (1000 × CTR × CVR)), pembanding periode lalu & baseline 90 hari,
// tren harian, dan rincian per iklan langsung dari Meta (frekuensi, ranking kualitas, retensi video, funnel website).
// Semua agregasi dikerjakan Postgres; panggilan Meta per iklan di-cache singkat supaya pertanyaan lanjutan tidak memanggil ulang.
import { addDays, div } from "@iklan/shared";
import { sql } from "./db";
import { cached } from "./cache";
import { metaMode } from "./env";
import { getEntities, num, rupiah } from "./meta/mcp";
import type { Range, Scope } from "./scope";

export interface Funnel {
  spend: number; impressions: number; clicks: number; results: number; value: number;
  cpm: number; ctr: number; cpc: number; cvr: number; costPerResult: number | null; metaRoas: number;
}

const r2 = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d + 0; // + 0 mengubah -0 jadi 0

export function funnel(x: { spend: number; impressions: number; clicks: number; results: number; value: number }): Funnel {
  return {
    spend: x.spend, impressions: x.impressions, clicks: x.clicks, results: x.results, value: x.value,
    cpm: Math.round(div(x.spend * 1000, x.impressions)),
    ctr: r2(div(x.clicks * 100, x.impressions)), // % klik tautan
    cpc: Math.round(div(x.spend, x.clicks)),
    cvr: r2(div(x.results * 100, x.clicks)), // % klik → hasil (pembelian/lead)
    costPerResult: x.results ? Math.round(x.spend / x.results) : null,
    metaRoas: r2(div(x.value, x.spend)),
  };
}

const pctChange = (a: number, b: number) => (b ? r2(((a - b) / b) * 100, 1) : null);

/**
 * Pecah perubahan biaya per hasil jadi kontribusi CPM, CTR, dan CVR (log-dekomposisi, total = 100%).
 * ln(CPA₁/CPA₀) = ln(CPM₁/CPM₀) − ln(CTR₁/CTR₀) − ln(CVR₁/CVR₀).
 */
export function decompose(cur: Funnel, prev: Funnel) {
  if (!cur.cpm || !prev.cpm || !cur.ctr || !prev.ctr || !cur.cvr || !prev.cvr) return null;
  const parts = { cpm: Math.log(cur.cpm / prev.cpm), ctr: -Math.log(cur.ctr / prev.ctr), cvr: -Math.log(cur.cvr / prev.cvr) };
  const total = parts.cpm + parts.ctr + parts.cvr;
  if (Math.abs(total) < 0.01) return { costPerResultChangePct: 0, drivers: "stabil" };
  const share = (v: number) => r2((v / total) * 100, 0);
  return {
    costPerResultChangePct: r2((Math.exp(total) - 1) * 100, 1),
    contributionPct: { cpm: share(parts.cpm), ctr: share(parts.ctr), cvr: share(parts.cvr) },
    mainDriver: (Object.entries(parts).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0][0]) as "cpm" | "ctr" | "cvr",
  };
}

/** Sinyal otomatis dari angka; model tetap yang menyimpulkan. */
export function signals(cur: Funnel, prev: Funnel, base: Funnel, half: { first: Funnel; second: Funnel } | null) {
  const out: string[] = [];
  const ch = (a: number, b: number) => pctChange(a, b) ?? 0;
  if (cur.results < 10) out.push(`Sampel kecil (${cur.results} hasil): perlakukan kesimpulan sebagai hipotesis, bukan kepastian.`);
  if (base.cpm && ch(cur.cpm, base.cpm) > 25) out.push(`CPM ${ch(cur.cpm, base.cpm)}% di atas baseline 90 hari: lelang lebih mahal, audiens jenuh, atau kualitas kreatif turun.`);
  if (base.ctr && ch(cur.ctr, base.ctr) < -20) out.push(`CTR ${ch(cur.ctr, base.ctr)}% di bawah baseline: hook/kreatif melemah atau sudah lelah.`);
  if (base.cvr && ch(cur.cvr, base.cvr) < -20 && cur.clicks >= 100) out.push(`Konversi setelah klik ${ch(cur.cvr, base.cvr)}% di bawah baseline: cek landing page, harga/offer, checkout, dan tracking pixel.`);
  if (half && half.first.ctr && ch(half.second.ctr, half.first.ctr) < -15 && ch(half.second.cpm, half.first.cpm) > 10)
    out.push("Di dalam periode ini CTR turun sementara CPM naik: pola klasik creative fatigue.");
  if (prev.spend && ch(cur.spend, prev.spend) > 50 && cur.costPerResult && prev.costPerResult && ch(cur.costPerResult, prev.costPerResult) > 20)
    out.push("Spend naik >50% dan biaya per hasil ikut naik >20%: scale terlalu cepat atau audiens mulai melebar ke segmen yang lebih mahal.");
  return out;
}

/** Total funnel untuk satu rentang tanggal, kolom diberi awalan `p` (satu scan untuk semua periode). */
const aggs = (p: string, from: string, to: string) => sql`
  COALESCE(sum(spend) FILTER (WHERE date BETWEEN ${from} AND ${to}), 0) AS ${sql(p + "spend")},
  COALESCE(sum(impressions) FILTER (WHERE date BETWEEN ${from} AND ${to}), 0) AS ${sql(p + "impressions")},
  COALESCE(sum(clicks) FILTER (WHERE date BETWEEN ${from} AND ${to}), 0) AS ${sql(p + "clicks")},
  COALESCE(sum(results) FILTER (WHERE date BETWEEN ${from} AND ${to}), 0) AS ${sql(p + "results")},
  COALESCE(sum(value) FILTER (WHERE date BETWEEN ${from} AND ${to}), 0) AS ${sql(p + "value")}`;

/** Diagnosa funnel satu kampanye atau seluruh scope: periode ini vs periode lalu vs baseline 90 hari, plus tren harian. */
export async function diagnose(scope: Scope, r: Range, campaignId: string | null) {
  const ids = scope.accountIds;
  const baseFrom = addDays(r.from, -90), baseTo = addDays(r.from, -1);
  const lo = baseFrom < r.prevFrom ? baseFrom : r.prevFrom;
  const mid = addDays(r.from, Math.floor(r.days / 2) - 1);
  // Hasil = pembelian untuk akun produk digital, lead untuk akun jasa. Nilai konversi pixel hanya bermakna untuk digital.
  const src = sql`
    SELECT d.date, d.spend, d.impressions, d.clicks,
           CASE WHEN a.line = 'jasa' THEN d.leads ELSE d.purchases END AS results,
           CASE WHEN a.line = 'jasa' THEN 0 ELSE d.purchase_value END AS value
    FROM campaign_daily d JOIN ad_accounts a ON a.id = d.account_id
    WHERE d.account_id = ANY(${ids}) AND d.date BETWEEN ${lo} AND ${r.to}
      ${campaignId ? sql`AND d.campaign_id = ${campaignId}` : sql``}`;
  const trendFrom = r.days > 31 ? addDays(r.to, -30) : r.from;
  const [[t], daily, camp] = await Promise.all([
    sql`
      SELECT ${aggs("", r.from, r.to)}, ${aggs("p_", r.prevFrom, r.prevTo)}, ${aggs("b_", baseFrom, baseTo)}, ${aggs("h1_", r.from, mid)}
      FROM (${src}) s`,
    sql`
      SELECT to_char(date, 'YYYY-MM-DD') AS date, sum(spend) AS spend, sum(impressions) AS impressions, sum(clicks) AS clicks,
             sum(results) AS results, sum(value) AS value
      FROM (${src}) s WHERE date BETWEEN ${trendFrom} AND ${r.to}
      GROUP BY date ORDER BY date`,
    campaignId
      ? sql`SELECT c.name, c.status, c.effective_status, c.daily_budget, c.objective, to_char(c.created_time, 'YYYY-MM-DD') AS created FROM campaigns c WHERE c.id = ${campaignId}`
      : Promise.resolve([]),
  ]);
  const pick = (p: string) => ({ spend: t[p + "spend"], impressions: t[p + "impressions"], clicks: t[p + "clicks"], results: t[p + "results"], value: t[p + "value"] });
  const cur = funnel(pick("")), prev = funnel(pick("p_")), base = funnel(pick("b_")), first = funnel(pick("h1_"));
  const second = funnel({ spend: cur.spend - first.spend, impressions: cur.impressions - first.impressions, clicks: cur.clicks - first.clicks, results: cur.results - first.results, value: cur.value - first.value });
  const half = r.days >= 6 ? { first, second } : null;
  const weekly = div(cur.results * 7, r.days);
  return {
    campaign: camp[0] ?? null,
    period: { from: r.from, to: r.to, days: r.days }, comparePeriod: { from: r.prevFrom, to: r.prevTo }, baselinePeriod: { from: baseFrom, to: baseTo },
    resultMeaning: scope.lines.length > 1 ? "pembelian (akun digital) + lead (akun jasa)" : scope.lines[0] === "jasa" ? "lead" : "pembelian (pixel Meta)",
    current: cur, previous: prev, baseline90d: base,
    changeVsPrevious: { cpm: pctChange(cur.cpm, prev.cpm), ctr: pctChange(cur.ctr, prev.ctr), cvr: pctChange(cur.cvr, prev.cvr), costPerResult: pctChange(cur.costPerResult ?? 0, prev.costPerResult ?? 0), spend: pctChange(cur.spend, prev.spend) },
    costDriversVsPrevious: decompose(cur, prev),
    costDriversVsBaseline: decompose(cur, base),
    withinPeriod: half && { firstHalf: { cpm: first.cpm, ctr: first.ctr, cvr: first.cvr, costPerResult: first.costPerResult }, secondHalf: { cpm: second.cpm, ctr: second.ctr, cvr: second.cvr, costPerResult: second.costPerResult } },
    learning: { resultsPerWeek: r2(weekly, 1), note: weekly < 50 ? "Di bawah ~50 hasil/minggu per ad set: algoritma sulit keluar dari learning; hindari memecah budget." : "Volume cukup untuk keluar dari learning." },
    signals: signals(cur, prev, base, half),
    daily: daily.map((d) => ({ date: d.date, ...funnel(d as any) })),
  };
}

/* ------------------------------------------------------------------ per iklan (live Meta) */

const AD_FIELDS = [
  "id", "name", "effective_status", "campaign_id", "adset_id", "amount_spent", "impressions", "reach", "frequency", "cpm",
  "link_click", "landing_page_view", "omni_add_to_cart", "omni_initiated_checkout", "omni_purchase", "omni_purchase_values", "lead", "results",
  "video_p25_watched_actions", "video_p75_watched_actions", "video_thruplay_watched_actions",
  "quality_ranking", "engagement_rate_ranking", "conversion_rate_ranking",
];
export const AD_PRESETS = ["last_7d", "last_14d", "last_30d"] as const;

const rank = (v: unknown) => (typeof v === "string" && v && v !== "UNKNOWN" ? v.toLowerCase() : null);

/** Ubah satu baris iklan dari Meta jadi metrik funnel siap analisis. */
export function adRow(e: any, line: "digital" | "jasa") {
  const spend = rupiah(e.amount_spent), impr = Math.round(num(e.impressions)), clicks = Math.round(num(e.link_click));
  const lpv = Math.round(num(e.landing_page_view)), atc = Math.round(num(e.omni_add_to_cart)), ic = Math.round(num(e.omni_initiated_checkout));
  const purchases = Math.round(num(e.omni_purchase)), leads = Math.round(num(e.lead)) || (line === "jasa" ? Math.round(num(e.results)) : 0);
  const results = line === "jasa" ? leads : purchases, value = line === "jasa" ? 0 : rupiah(e.omni_purchase_values);
  const p25 = num(e.video_p25_watched_actions), p75 = num(e.video_p75_watched_actions), thru = num(e.video_thruplay_watched_actions);
  return {
    id: String(e.id), name: e.name, status: e.effective_status, campaignId: e.campaign_id ? String(e.campaign_id) : null,
    spend, impressions: impr, reach: Math.round(num(e.reach)), frequency: r2(num(e.frequency)),
    cpm: Math.round(div(spend * 1000, impr)), ctrLink: r2(div(clicks * 100, impr)), cpc: Math.round(div(spend, clicks)),
    landingRate: lpv ? r2(div(lpv * 100, clicks), 1) : null, // % klik yang benar-benar memuat halaman
    addToCart: atc, checkout: ic, results, costPerResult: results ? Math.round(spend / results) : null,
    cvrFromClick: r2(div(results * 100, clicks)), metaRoas: value ? r2(div(value, spend)) : null,
    video: p25 ? { holdRate25: r2(div(p25 * 100, impr), 1), p75OfP25: r2(div(p75 * 100, p25), 1), thruplayRate: r2(div(thru * 100, impr), 1) } : null,
    rankings: { quality: rank(e.quality_ranking), engagement: rank(e.engagement_rate_ranking), conversion: rank(e.conversion_rate_ranking) },
  };
}

/** Rincian per iklan (kreatif) untuk satu akun, opsional satu kampanye. Diurutkan dari spend terbesar. */
export async function adBreakdown(account: { id: string; line: "digital" | "jasa" }, campaignId: string | null, preset: (typeof AD_PRESETS)[number], limit: number) {
  if (metaMode() !== "mcp") return { error: "Rincian per iklan butuh jalur MCP Meta." };
  return cached(`ads|${account.id}|${campaignId}|${preset}|${limit}`, async () => {
    const rows = await getEntities({
      ad_account_id: account.id, level: "ad", date_preset: preset, fields: AD_FIELDS, sort: "amount_spent_descending", limit: Math.min(limit, 50),
      ...(campaignId ? { filtering: [{ field: "campaign_id", operator: "IN", value: [campaignId] }] } : {}),
    }, { job: "report_measure_or_look_up", request: "analisis performa per iklan & kreatif" }, 1);
    const ads = rows.map((e) => adRow(e, account.line)).filter((a) => a.spend > 0);
    const tot = ads.reduce((s, a) => ({ spend: s.spend + a.spend, results: s.results + a.results }), { spend: 0, results: 0 });
    return {
      period: preset, resultMeaning: account.line === "jasa" ? "lead" : "pembelian (pixel Meta)",
      totals: { ads: ads.length, spend: tot.spend, results: tot.results, costPerResult: tot.results ? Math.round(tot.spend / tot.results) : null },
      ads: ads.slice(0, limit).map((a) => ({ ...a, spendShare: r2(div(a.spend * 100, tot.spend), 1) })),
      notes: "ctrLink = klik tautan/tayangan; landingRate = landing page view/klik (<70% → halaman lambat/klik tidak sengaja); holdRate25 = video ditonton 25%/tayangan; ranking dibanding iklan lain yang bersaing untuk audiens sama (null = data belum cukup).",
    };
  });
}
