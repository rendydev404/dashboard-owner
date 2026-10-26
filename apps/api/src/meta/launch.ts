// Buat & luncurkan kampanye Meta dari chat (lewat MCP Meta Ads), termasuk multi-iklan (A/B kreatif & angle) dan injeksi iklan baru
// ke kampanye/ad set pemenang yang sudah berjalan, lengkap dengan audit kualitas & kebijakan sebelum tayang.
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { metaMode } from "../env";
import { sql } from "../db";
import { loadConfig, resolveRange, resolveScope, type Config } from "../scope";
import * as Q from "../queries";
import { callTool, conversationId, unwrap } from "./mcp";
import { videoStatus } from "./upload";

export const LAUNCH_OBJECTIVES = ["sales", "leads_website", "leads_whatsapp", "traffic"] as const;
export const LAUNCH_CTAS = ["SHOP_NOW", "BUY_NOW", "LEARN_MORE", "SIGN_UP", "ORDER_NOW", "GET_OFFER", "CONTACT_US", "APPLY_NOW", "SUBSCRIBE", "WHATSAPP_MESSAGE"] as const;

export const creativeSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("existing"), creativeId: z.string().regex(/^\d+$/) }),
  z.object({ type: z.literal("post"), objectStoryId: z.string().regex(/^\d+_\d+$/) }),
  z.object({
    type: z.literal("new"),
    imageHash: z.string().optional(), imageUrl: z.string().url().optional(), videoId: z.string().regex(/^\d+$/).optional(),
    primaryText: z.string().trim().min(10).max(2000), headline: z.string().trim().min(2).max(120), description: z.string().max(200).optional(),
    cta: z.enum(LAUNCH_CTAS).default("LEARN_MORE"),
  }),
]);
export type CreativeSpec = z.infer<typeof creativeSpecSchema>;

export const adItemSchema = z.object({
  adName: z.string().trim().min(3).max(120),
  creative: creativeSpecSchema,
  linkUrl: z.string().url().optional(),
});
export type AdItem = z.infer<typeof adItemSchema>;

const launchPlanRawSchema = z.object({
  accountId: z.string().regex(/^\d{5,25}$/),
  campaignName: z.string().trim().min(3).max(120),
  objective: z.enum(LAUNCH_OBJECTIVES),
  dailyBudget: z.number().int().positive(),
  pageId: z.string().regex(/^\d+$/),
  instagramUserId: z.string().regex(/^\d+$/).optional(),
  pixelId: z.string().regex(/^\d+$/).optional(),
  linkUrl: z.string().url().optional(),
  autoUtm: z.boolean().optional(),
  targeting: z.object({
    countries: z.array(z.string().length(2)).min(1).max(10).default(["ID"]),
    ageMin: z.number().int().min(18).max(65).default(18),
    ageMax: z.number().int().min(18).max(65).default(65),
    genders: z.enum(["all", "male", "female"]).default("all"),
  }).default({}),
  creative: creativeSpecSchema.optional(),
  adName: z.string().trim().min(3).max(120).optional(),
  ads: z.array(adItemSchema).min(1).max(5).optional(),
  startNow: z.boolean().default(true),
  rationale: z.string().max(1500).optional(),
}).superRefine((val, ctx) => {
  if (!val.ads?.length && (!val.creative || !val.adName)) {
    if (!val.creative) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["creative"], message: "Wajib isi creative (atau array ads 1–5 variasi)." });
    if (!val.adName) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["adName"], message: "Wajib isi adName (atau array ads 1–5 variasi)." });
  }
});

export const launchPlanSchema = launchPlanRawSchema.transform((val) => {
  const first = val.ads?.[0];
  const creative = val.creative ?? first!.creative;
  const adName = val.adName ?? first!.adName;
  return { ...val, creative, adName };
});
export type LaunchPlan = z.output<typeof launchPlanSchema>;

/** Normalisasi daftar iklan di rencana kampanye (mendukung format 1 iklan klasik maupun multi-iklan 1–5 variasi). */
export function planAds(p: Pick<LaunchPlan, "adName" | "creative" | "ads" | "linkUrl">): AdItem[] {
  if (p.ads?.length) return p.ads;
  return [{ adName: p.adName, creative: p.creative, linkUrl: p.linkUrl }];
}

/** Skema injeksi 1–5 iklan baru ke kampanye / ad set yang sudah ada (tanpa memecah kampanye baru). */
export const addAdsPlanSchema = z.object({
  accountId: z.string().regex(/^\d{5,25}$/),
  campaignId: z.string().regex(/^\d+$/),
  campaignName: z.string().trim().optional(),
  adsetId: z.string().regex(/^\d+$/).optional(),
  adsetName: z.string().trim().optional(),
  objective: z.enum(LAUNCH_OBJECTIVES),
  pageId: z.string().regex(/^\d+$/),
  instagramUserId: z.string().regex(/^\d+$/).optional(),
  linkUrl: z.string().url().optional(),
  autoUtm: z.boolean().optional(),
  ads: z.array(adItemSchema).min(1).max(5),
  startNow: z.boolean().default(true),
  rationale: z.string().max(1500).optional(),
});
export type AddAdsPlan = z.infer<typeof addAdsPlanSchema>;

export interface LaunchStep { step: "campaign" | "adset" | "creative" | "ad" | "publish"; id?: string; ok: boolean; note?: string }
export interface LaunchResult {
  campaignId: string | null;
  adsetId: string | null;
  creativeId: string | null;
  adId: string | null;
  creativeIds?: string[];
  adIds?: string[];
  published: boolean;
  steps: LaunchStep[];
}

export interface PlanAuditItem { level: "ok" | "warn"; check: string; detail: string }

const DEFAULT_MAX_DAILY = 1_000_000; // batas aman per peluncuran bila akun belum punya maxDailyBudget

const job = (request: string) => ({ job: "create_and_launch_new_ads" as const, request });
const idOf = (r: any, ...keys: string[]): string | null => {
  for (const k of keys) { const v = r?.[k]; if (v) return String(v); }
  return r?.id ? String(r.id) : null;
};
const errorsOf = (r: any): string | null => {
  const e = unwrap(r?.active_errors);
  if (!e || (Array.isArray(e) && !e.length)) return null;
  return typeof e === "string" ? e : JSON.stringify(e).slice(0, 600);
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "ad";

/** Sisipkan parameter UTM bila autoUtm aktif dan URL belum punya utm_source. */
export function buildFinalLink(rawUrl: string | undefined, autoUtm: boolean | undefined, campaignName: string, adName: string): string | undefined {
  if (!rawUrl) return undefined;
  if (!autoUtm) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (!u.searchParams.has("utm_source")) {
      u.searchParams.set("utm_source", "meta");
      u.searchParams.set("utm_medium", "paid_social");
      u.searchParams.set("utm_campaign", slug(campaignName));
      u.searchParams.set("utm_content", slug(adName));
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

const POLICY_PERSONAL_ATTR = /\b(kamu|anda|lo|lu)\s+(yang\s+)?(masih\s+|lagi\s+|sedang\s+)?(boncos|miskin|pengangguran|nganggur|hutang|utang|terlilit|stres|depresi|gemuk|gendut|jerawatan|bangkrut|gagal\s+terus)\b/i;
const POLICY_UNREALISTIC = /\b(dijamin\s+(cuan|untung|kaya|berhasil|laku|closing|balik\s+modal)|pasti\s+(cuan|kaya|untung|closing)|auto\s+(kaya|cuan|sultan)|100%\s+(pasti|cuan|untung|berhasil)|cepat\s+kaya)\b/i;

/** Audit spesialis: kepatuhan kebijakan Meta Ads, pemotongan teks mobile, hook 125 karakter, dan rasio budget terhadap target CPA/CPL. */
export function auditLaunchPlan(
  opts: { objective: string; dailyBudget?: number; linkUrl?: string; ads: AdItem[] },
  econ?: { targetCpa?: number | null; line?: "digital" | "jasa" },
): PlanAuditItem[] {
  const checks: PlanAuditItem[] = [];
  const ads = opts.ads;

  // 1) Keberagaman / jumlah variasi kreatif
  if (ads.length > 1) {
    checks.push({ level: "ok", check: "Multi-variasi iklan", detail: `${ads.length} iklan digabung dalam 1 ad set supaya algoritma Meta mengalokasikan spend ke kreatif/angle terbaik.` });
  }

  // 2) Audit tiap variasi copy & kebijakan Meta
  let headlineWarn = false, hookOk = true, policyWarn: string | null = null;
  for (const item of ads) {
    if (item.creative.type !== "new") continue;
    const { headline, primaryText, description } = item.creative;
    const combined = `${headline} ${primaryText} ${description ?? ""}`;
    if (headline.length > 40) headlineWarn = true;
    const firstFold = primaryText.slice(0, 125).trim();
    if (firstFold.length < 25) hookOk = false;
    if (!policyWarn && POLICY_PERSONAL_ATTR.test(combined)) {
      policyWarn = `Iklan "${item.adName}": hindari menyebut kondisi pribadi penonton secara langsung ("Kamu yang…") karena rawan ditolak kebijakan Personal Attributes Meta.`;
    }
    if (!policyWarn && POLICY_UNREALISTIC.test(combined)) {
      policyWarn = `Iklan "${item.adName}": klaim janji hasil/penghasilan pasti ("dijamin cuan / auto kaya / 100% pasti") berisiko memicu pembatasan akun iklan Meta.`;
    }
  }
  if (policyWarn) checks.push({ level: "warn", check: "Kebijakan Meta Ads", detail: policyWarn });
  else checks.push({ level: "ok", check: "Kebijakan Meta Ads", detail: "Teks bebas dari pola klaim berlebihan dan atribut personal terlarang." });

  if (headlineWarn) {
    checks.push({ level: "warn", check: "Panjang Headline", detail: "Ada headline > 40 karakter yang berpotensi terpotong '...' di layar HP Feed/Reels." });
  } else if (ads.some((a) => a.creative.type === "new")) {
    checks.push({ level: "ok", check: "Headline Mobile", detail: "Headline ≤ 40 karakter, aman tampil utuh di Feed & Reels." });
  }

  if (!hookOk) {
    checks.push({ level: "warn", check: "Hook Baris Pertama", detail: "Pembuka primary text terlalu pendek (< 25 karakter); maksimalkan 125 karakter pertama sebelum tombol 'Lihat selengkapnya'." });
  }

  // 3) Rasio budget harian terhadap target CPA/CPL
  const targetCpa = econ?.targetCpa ?? null;
  if (opts.dailyBudget && targetCpa && targetCpa > 0) {
    const ratio = opts.dailyBudget / targetCpa;
    const metricName = econ?.line === "jasa" ? "CPL" : "CPA";
    if (ratio < 1) {
      checks.push({
        level: "warn",
        check: `Rasio Budget vs ${metricName}`,
        detail: `Budget harian (${ Math.round(ratio * 10) / 10 }× batas ${metricName}) di bawah 1× target ${metricName}; sinyal konversi lebih lambat, wajib tahan minimal 3–5 hari sebelum evaluasi.`,
      });
    } else {
      checks.push({
        level: "ok",
        check: `Rasio Budget vs ${metricName}`,
        detail: `Budget setara ${Math.round(ratio * 10) / 10}× batas ${metricName} (~${Math.max(1, Math.round(ratio))} target hasil/hari).`,
      });
    }
  }
  return checks;
}

/** Validasi satu item kreatif terhadap tujuan kampanye. */
function validateCreativeItem(c: CreativeSpec, objective: (typeof LAUNCH_OBJECTIVES)[number], fallbackLink: string | undefined, itemLink: string | undefined, labelPrefix: string) {
  const web = objective !== "leads_whatsapp";
  const link = itemLink ?? fallbackLink;
  if (web && c.type === "new" && !link) throw new Error(`${labelPrefix}Iklan ke website butuh linkUrl (halaman produk/landing page).`);
  if (c.type === "new") {
    if (!c.imageHash && !c.imageUrl && !c.videoId) throw new Error(`${labelPrefix}Kreatif baru butuh gambar (imageHash/imageUrl) atau videoId.`);
    if (c.imageHash && c.imageUrl) throw new Error(`${labelPrefix}Pilih salah satu: imageHash atau imageUrl.`);
    if (objective === "leads_whatsapp" && c.cta !== "WHATSAPP_MESSAGE") throw new Error(`${labelPrefix}Iklan WhatsApp wajib CTA WHATSAPP_MESSAGE.`);
    if (objective !== "leads_whatsapp" && c.cta === "WHATSAPP_MESSAGE") throw new Error(`${labelPrefix}CTA WHATSAPP_MESSAGE hanya untuk tujuan leads_whatsapp.`);
  }
}

/** Info akun untuk guardrail: nama, lini, minimal budget harian dari Meta, batas maksimal dari aturan akun. */
async function accountLimits(accountId: string, cfg: Config) {
  const acc = cfg.accounts.find((a) => a.id === accountId && a.active);
  if (!acc) throw new Error("Akun iklan tidak terdaftar di dashboard atau tidak aktif. Tanyakan ke user akun yang mana.");
  let minDaily = 0;
  try {
    const r = await callTool("ads_get_ad_accounts", {}, job("cek minimal budget akun"));
    const row = (unwrap<any[]>(r.ad_accounts) ?? []).find((x: any) => String(x.ad_account_id) === accountId);
    minDaily = Number(row?.min_daily_budget_cents ?? 0);
  } catch { /* minimal budget tetap divalidasi Meta saat publish */ }
  return { acc, minDaily, maxDaily: acc.settings.maxDailyBudget ?? DEFAULT_MAX_DAILY };
}

/** Validasi rencana sebelum kartu konfirmasi dibuat. Pesan error ditujukan ke model supaya bisa bertanya/memperbaiki. */
export async function validateLaunchPlan(raw: unknown): Promise<{
  plan: LaunchPlan; accountName: string; minDaily: number; maxDaily: number; audit: PlanAuditItem[];
}> {
  if (metaMode() !== "mcp") throw new Error("Peluncuran iklan butuh jalur MCP Meta (login Claude Code di VPS). Jalur Graph API belum mendukung pembuatan iklan.");
  const parsed = launchPlanSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Rencana belum lengkap/valid: " + JSON.stringify(parsed.error.flatten().fieldErrors));
  const plan = parsed.data;
  const cfg = await loadConfig();
  const { acc, minDaily, maxDaily } = await accountLimits(plan.accountId, cfg);
  if (plan.dailyBudget < minDaily) throw new Error(`Budget harian minimal akun ini Rp${minDaily.toLocaleString("id-ID")}.`);
  if (plan.dailyBudget > maxDaily) throw new Error(`Budget harian melebihi batas aman Rp${maxDaily.toLocaleString("id-ID")}/hari. Minta user menaikkan "budget harian maksimal" di Pengaturan akun kalau memang mau lebih.`);
  if (plan.targeting.ageMin > plan.targeting.ageMax) throw new Error("ageMin harus ≤ ageMax");
  if ((plan.objective === "sales" || plan.objective === "leads_website") && !plan.pixelId) {
    throw new Error("Tujuan ini butuh pixel (dataset) untuk mengukur konversi. Ambil dari get_launch_context.");
  }
  const items = planAds(plan);
  items.forEach((it, idx) => validateCreativeItem(it.creative, plan.objective, plan.linkUrl, it.linkUrl, items.length > 1 ? `[Iklan #${idx + 1} "${it.adName}"] ` : ""));
  const targetCpa = acc.line === "jasa" ? acc.settings.maxCpl : acc.settings.maxCpa;
  const audit = auditLaunchPlan({ objective: plan.objective, dailyBudget: plan.dailyBudget, linkUrl: plan.linkUrl, ads: items }, { targetCpa, line: acc.line });
  return { plan, accountName: acc.name, minDaily, maxDaily, audit };
}

/** Validasi rencana injeksi iklan baru ke kampanye / ad set aktif yang sudah ada. */
export async function validateAddAdsPlan(raw: unknown): Promise<{
  plan: AddAdsPlan; accountName: string; campaignName: string; adsetId: string; adsetName: string; audit: PlanAuditItem[];
}> {
  if (metaMode() !== "mcp") throw new Error("Penambahan iklan butuh jalur MCP Meta (login Claude Code di VPS).");
  const parsed = addAdsPlanSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Rencana tambah iklan belum lengkap/valid: " + JSON.stringify(parsed.error.flatten().fieldErrors));
  const plan = parsed.data;
  const cfg = await loadConfig();
  const { acc } = await accountLimits(plan.accountId, cfg);

  const [campRow] = await sql`SELECT id, name, status FROM campaigns WHERE id = ${plan.campaignId} AND account_id = ${plan.accountId}`;
  const campaignName = campRow?.name ?? plan.campaignName ?? `Kampanye #${plan.campaignId}`;

  let adsetId = plan.adsetId ?? "";
  let adsetName = plan.adsetName ?? "";
  if (!adsetId) {
    const r = await callTool("ads_get_ad_entities", {
      ad_account_id: plan.accountId,
      level: "adset",
      fields: ["id", "name", "effective_status", "campaign_id"],
      filtering: [{ field: "campaign_id", operator: "IN", value: [plan.campaignId] }],
      limit: 20,
    }, job("cari ad set di kampanye tujuan"));
    const rows = (unwrap<any[]>(r.ad_entities) ?? []).filter((x) => !["DELETED", "ARCHIVED"].includes(String(x.effective_status ?? "")));
    if (!rows.length) throw new Error("Kampanye ini belum punya ad set aktif. Gunakan propose_launch untuk membuat kampanye baru.");
    const active = rows.filter((x) => String(x.effective_status) === "ACTIVE");
    const candidates = active.length ? active : rows;
    if (candidates.length > 1) {
      throw new Error(`Kampanye "${campaignName}" memiliki ${candidates.length} ad set: ${candidates.map((x) => `${x.name} (adsetId=${x.id})`).join(", ")}. Pilih salah satu dan isi adsetId.`);
    }
    adsetId = String(candidates[0].id);
    adsetName = String(candidates[0].name ?? adsetId);
  }
  plan.ads.forEach((it, idx) => validateCreativeItem(it.creative, plan.objective, plan.linkUrl, it.linkUrl, `[Iklan #${idx + 1} "${it.adName}"] `));
  const targetCpa = acc.line === "jasa" ? acc.settings.maxCpl : acc.settings.maxCpa;
  const audit = auditLaunchPlan({ objective: plan.objective, linkUrl: plan.linkUrl, ads: plan.ads }, { targetCpa, line: acc.line });
  return { plan: { ...plan, campaignName, adsetId, adsetName }, accountName: acc.name, campaignName, adsetId, adsetName, audit };
}

/** Dossier intelijen lengkap sebelum merancang iklan: unit economics per produk, iklan pemenang 30h, ad set aktif, jam cuan, Page/IG/Pixel. */
export async function launchContext(accountId: string) {
  if (metaMode() !== "mcp") return { error: "Peluncuran iklan butuh jalur MCP Meta." };
  const cfg = await loadConfig();
  const { acc, minDaily, maxDaily } = await accountLimits(accountId, cfg);
  const ctx = { conv: conversationId(), ...job("siapkan aset & intelijen performa untuk iklan baru") };
  const safe = async <T>(p: Promise<T>): Promise<T | { error: string }> => p.catch((e) => ({ error: (e as Error).message.slice(0, 200) }));

  const r30 = resolveRange(undefined, undefined, "30d");
  const scope = resolveScope(accountId, cfg);

  const [pages, ig, datasets, creatives, adsetsResp, liveAdsResp, top, prodRows, feeRow, summary30, hourly30] = await Promise.all([
    safe(callTool("ads_get_ad_account_pages", { ad_account_id: accountId, limit: 10 }, ctx)),
    safe(callTool("ads_get_ig_accounts", { ad_account_id: accountId, limit: 10 }, ctx)),
    safe(callTool("ads_get_datasets", { ad_account_id: accountId, limit: 10 }, ctx)),
    safe(callTool("ads_get_creatives", {
      ad_account_id: accountId, limit: 15,
      fields: ["id", "name", "status", "body", "title", "call_to_action_type", "object_story_id", "image_hash", "video_id", "link_url"],
    }, ctx)),
    safe(callTool("ads_get_ad_entities", {
      ad_account_id: accountId, level: "adset", limit: 15,
      fields: ["id", "name", "campaign_id", "effective_status", "daily_budget", "optimization_goal", "destination_type"],
      filtering: [{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }],
    }, ctx)),
    safe(callTool("ads_get_ad_entities", {
      ad_account_id: accountId, level: "ad", date_preset: "last_30d", sort: "amount_spent_descending", limit: 20,
      fields: ["id", "name", "effective_status", "campaign_id", "adset_id", "amount_spent", "impressions", "link_click", "landing_page_view", "omni_purchase", "omni_purchase_values", "lead", "results", "video_p25_watched_actions", "quality_ranking", "conversion_rate_ranking"],
    }, ctx)),
    sql`
      SELECT c.id, c.name, c.status, c.daily_budget, SUM(d.spend)::bigint AS spend, SUM(d.purchases)::int AS purchases,
             SUM(d.leads)::int AS leads, SUM(d.purchase_value)::bigint AS value
      FROM campaign_daily d JOIN campaigns c ON c.id = d.campaign_id
      WHERE d.account_id = ${accountId} AND d.date >= (now() AT TIME ZONE 'Asia/Jakarta')::date - 30
      GROUP BY c.id ORDER BY SUM(d.spend) DESC LIMIT 8`,
    sql`
      SELECT p.name, p.price, p.cogs, p.url,
             COALESCE(SUM(s.qty) FILTER (WHERE s.deleted_at IS NULL AND s.date >= (now() AT TIME ZONE 'Asia/Jakarta')::date - 30), 0)::int AS qty_30d,
             COALESCE(SUM(s.revenue) FILTER (WHERE s.deleted_at IS NULL AND s.date >= (now() AT TIME ZONE 'Asia/Jakarta')::date - 30), 0)::bigint AS rev_30d
      FROM products p
      LEFT JOIN sales s ON s.product_id = p.id
      WHERE p.active AND p.line = ${acc.line}
      GROUP BY p.id
      ORDER BY rev_30d DESC, p.name
      LIMIT 20`,
    sql`SELECT fee_pct FROM line_settings WHERE line = ${acc.line}`,
    Q.summaryFor(scope, r30, cfg).catch(() => null),
    Q.hourly(scope, r30).catch(() => null),
  ]);

  const feePct = Number(feeRow[0]?.fee_pct ?? (acc.line === "digital" ? 5 : 0));
  const adTaxMult = 1 + (acc.settings.adTaxPct ?? 0) / 100;
  const targetCpa = (acc.line === "jasa" ? acc.settings.maxCpl : acc.settings.maxCpa) ?? 0;

  // Hitung unit economics per produk supaya AI tahu batas CPA impas & margin bersih tiap produk
  const products = prodRows.map((p) => {
    const price = p.price != null ? Number(p.price) : null;
    const cogs = Number(p.cogs ?? 0);
    const fee = price != null ? Math.round((price * feePct) / 100) : null;
    const grossMargin = price != null && fee != null ? price - cogs - fee : null;
    const maxBreakEvenCpa = grossMargin != null && grossMargin > 0 ? Math.floor(grossMargin / adTaxMult) : null;
    const breakEvenRoas = price != null && grossMargin != null && grossMargin > 0 ? Math.round(((price * adTaxMult) / grossMargin) * 100) / 100 : null;
    return {
      name: p.name as string,
      price,
      cogs,
      platformFeePct: feePct,
      profitBeforeAds: grossMargin,
      maxBreakEvenCpa,
      breakEvenRoas,
      sold30d: Number(p.qty_30d ?? 0),
      revenue30d: Number(p.rev_30d ?? 0),
      url: (p.url as string | null) ?? null,
    };
  });

  // Ringkas iklan pemenang & iklan boncos 30 hari terakhir sebagai referensi pola kreatif
  const rawLiveAds = Array.isArray(unwrap((liveAdsResp as any)?.ad_entities)) ? unwrap<any[]>((liveAdsResp as any).ad_entities) : [];
  const numVal = (v: any): number => {
    if (v == null) return 0;
    if (typeof v === "number") return v;
    if (typeof v === "object") return Array.isArray(v.values) ? v.values.reduce((s: number, x: any) => s + numVal(x), 0) : numVal(v.value);
    const n = Number(String(v).replace("%", "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  };
  const parsedAds = rawLiveAds.map((e) => {
    const spend = Math.round(numVal(e.amount_spent));
    const impr = Math.round(numVal(e.impressions));
    const clicks = Math.round(numVal(e.link_click));
    const lpv = Math.round(numVal(e.landing_page_view));
    const res = acc.line === "jasa" ? (Math.round(numVal(e.lead)) || Math.round(numVal(e.results))) : Math.round(numVal(e.omni_purchase));
    const val = acc.line === "jasa" ? 0 : Math.round(numVal(e.omni_purchase_values));
    const p25 = numVal(e.video_p25_watched_actions);
    return {
      id: String(e.id),
      name: String(e.name ?? ""),
      status: String(e.effective_status ?? ""),
      campaignId: e.campaign_id ? String(e.campaign_id) : null,
      spend,
      results: res,
      costPerResult: res > 0 ? Math.round(spend / res) : null,
      metaRoas: val > 0 && spend > 0 ? Math.round((val / spend) * 100) / 100 : null,
      ctrLinkPct: impr > 0 ? Math.round((clicks * 10000) / impr) / 100 : 0,
      landingRatePct: clicks > 0 && lpv > 0 ? Math.round((lpv * 1000) / clicks) / 10 : null,
      videoHold25Pct: impr > 0 && p25 > 0 ? Math.round((p25 * 1000) / impr) / 10 : null,
      qualityRanking: typeof e.quality_ranking === "string" && e.quality_ranking !== "UNKNOWN" ? e.quality_ranking.toLowerCase() : null,
    };
  }).filter((a) => a.spend > 0);

  const winningAds30d = [...parsedAds]
    .filter((a) => a.results >= 2 && a.costPerResult != null)
    .sort((a, b) => (a.costPerResult! - b.costPerResult!) || (b.results - a.results))
    .slice(0, 5);

  const bleedingAds30d = [...parsedAds]
    .filter((a) => a.results === 0 && a.spend >= Math.max(targetCpa || 50_000, 50_000))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 3);

  const k30 = summary30?.kpis;
  const activeAdsets = Array.isArray(unwrap((adsetsResp as any)?.ad_entities))
    ? unwrap<any[]>((adsetsResp as any).ad_entities).map((s) => ({
        id: String(s.id),
        name: String(s.name ?? ""),
        campaignId: s.campaign_id ? String(s.campaign_id) : null,
        dailyBudget: s.daily_budget != null ? Math.round(numVal(s.daily_budget)) : null,
        optimizationGoal: s.optimization_goal ?? null,
        destinationType: s.destination_type ?? null,
      }))
    : [];

  return {
    account: {
      id: acc.id,
      name: acc.name,
      line: acc.line,
      currency: "IDR",
      minDailyBudget: minDaily,
      maxDailyBudget: maxDaily,
      targetRoas: acc.settings.targetRoas,
      maxCpa: acc.settings.maxCpa,
      maxCpl: acc.settings.maxCpl,
      killAfterSpend: acc.settings.killAfterSpend,
      adTaxPct: acc.settings.adTaxPct,
    },
    unitEconomics30d: k30 ? {
      realRoas: Math.round(k30.roas * 100) / 100,
      breakEvenRoas: Math.round(k30.beRoas * 100) / 100,
      realAov: Math.round(k30.aov),
      maxCpaBreakEven: Math.round(k30.maxCpaBE),
      closeRatePct: k30.leads > 0 ? Math.round(k30.closeRate * 1000) / 10 : null,
      recommendedTestingDailyBudget: targetCpa > 0 ? Math.max(minDaily, Math.round(targetCpa * 2)) : null,
      learningPhaseExitDailyBudget: targetCpa > 0 ? Math.max(minDaily, Math.ceil((targetCpa * 50) / 7)) : null,
    } : null,
    bestHours30d: hourly30?.best.slice(0, 3).map((h) => ({
      hour: `${String(h.hour).padStart(2, "0")}:00`,
      results: h.results,
      costPerResult: h.cost ? Math.round(h.cost) : null,
    })) ?? [],
    pages: unwrap((pages as any).pages ?? (pages as any).data ?? pages),
    instagramAccounts: unwrap((ig as any).ig_accounts ?? (ig as any).instagram_accounts ?? (ig as any).data ?? ig),
    pixels: unwrap((datasets as any).datasets ?? (datasets as any).data ?? datasets),
    existingCreatives: unwrap((creatives as any).ad_creatives ?? (creatives as any).creatives ?? creatives),
    activeAdsets,
    winningAds30d,
    bleedingAds30d,
    topCampaigns30d: top.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      dailyBudget: r.daily_budget != null ? Number(r.daily_budget) : null,
      spend: Number(r.spend),
      purchases: Number(r.purchases),
      leads: Number(r.leads),
      roas: Number(r.spend) ? Math.round((Number(r.value) / Number(r.spend)) * 100) / 100 : 0,
    })),
    products,
  };
}

function objectiveSpec(p: Pick<LaunchPlan, "objective" | "pixelId" | "pageId">) {
  switch (p.objective) {
    case "sales": return { objective: "OUTCOME_SALES", goal: "OFFSITE_CONVERSIONS", destination: "WEBSITE", promoted: { pixel_id: p.pixelId, custom_event_type: "PURCHASE" } };
    case "leads_website": return { objective: "OUTCOME_LEADS", goal: "OFFSITE_CONVERSIONS", destination: "WEBSITE", promoted: { pixel_id: p.pixelId, custom_event_type: "LEAD" } };
    case "leads_whatsapp": return { objective: "OUTCOME_LEADS", goal: "CONVERSATIONS", destination: "WHATSAPP", promoted: { page_id: p.pageId } };
    // Meta: untuk OUTCOME_TRAFFIC dengan LANDING_PAGE_VIEWS/LINK_CLICKS, promoted_object harus dikosongkan.
    case "traffic": return { objective: "OUTCOME_TRAFFIC", goal: "LANDING_PAGE_VIEWS", destination: "WEBSITE", promoted: undefined };
  }
}

/** Tambahkan petunjuk untuk error Meta yang penyebabnya ada di pengaturan akun, bukan di rencana iklan. */
export function explain(note: string): string {
  if (/2310081|set produk tidak valid|invalid product set/i.test(note))
    return note + " — Petunjuk: akun ini terhubung ke katalog (mis. CPAS) yang set produknya tidak bisa diakses, sehingga Meta menolak ad set PENJUALAN. Perbaiki akses/hapus katalog itu dari akun iklan di Business Manager, atau pakai tujuan prospek/traffic.";
  if (/1885183|app is in development mode/i.test(note))
    return note + " — Petunjuk: aplikasi OAuth Meta masih mode Development. Ubah ke Live di developers.facebook.com atau gunakan jalur login MCP Meta Ads.";
  if (/1487390|creative.*invalid|thumbnail/i.test(note))
    return note + " — Petunjuk: aset kreatif/thumbnail ditolak Meta (pastikan rasio gambar/video valid dan video sudah selesai diproses).";
  return note;
}

const itemNeedsVideoThumb = (c: CreativeSpec) => c.type === "new" && !!c.videoId && !c.imageHash && !c.imageUrl;

/** Pastikan semua video dalam daftar iklan sudah selesai diproses Meta sebelum mengeksekusi konfirmasi. */
export async function assertAdsMediaReady(accountId: string, items: AdItem[]) {
  for (const it of items) {
    if (!itemNeedsVideoThumb(it.creative) || it.creative.type !== "new") continue;
    const v = await videoStatus(accountId, it.creative.videoId!);
    if (v.status === "error") throw new HTTPException(409, { message: `Meta gagal memproses video untuk "${it.adName}". Upload ulang videonya lewat chat.` });
    if (v.status !== "ready" || !v.picture) {
      throw new HTTPException(409, { message: `Video "${it.adName}" masih diproses Meta${v.progress != null ? ` (${v.progress}%)` : ""}. Tunggu 1–2 menit lalu tekan "Ya, eksekusi" lagi.` });
    }
  }
}

export async function assertLaunchMediaReady(p: LaunchPlan) {
  return assertAdsMediaReady(p.accountId, planAds(p));
}

/** Bantu siapkan thumbnail Meta untuk semua iklan video yang tidak memiliki cover custom. */
async function resolveVideoThumbs(accountId: string, items: AdItem[]): Promise<{ ok: true; thumbs: Map<number, string> } | { ok: false; note: string }> {
  const thumbs = new Map<number, string>();
  for (let i = 0; i < items.length; i++) {
    const c = items[i].creative;
    if (!itemNeedsVideoThumb(c) || c.type !== "new") continue;
    try {
      const v = await videoStatus(accountId, c.videoId!);
      if (v.status !== "ready" || !v.picture) return { ok: false, note: `Video belum siap dipakai (status ${v.status}). Tidak ada yang dibuat.` };
      thumbs.set(i, v.picture);
    } catch (e) {
      return { ok: false, note: `Gagal cek video: ${(e as Error).message}` };
    }
  }
  return { ok: true, thumbs };
}

/** Buat pasangan creative + ad (status DRAFT) di dalam satu ad set. */
async function createAdsInAdset(opts: {
  accountId: string;
  adsetId: string;
  campaignName: string;
  pageId: string;
  instagramUserId?: string;
  defaultLinkUrl?: string;
  autoUtm?: boolean;
  items: AdItem[];
  thumbs: Map<number, string>;
  ctx: { conv: string; job: "create_and_launch_new_ads"; request: string };
  steps: LaunchStep[];
}): Promise<{ ok: boolean; creativeIds: string[]; adIds: string[] }> {
  const base = { ad_account_id: opts.accountId };
  const creativeIds: string[] = [];
  const adIds: string[] = [];
  const multi = opts.items.length > 1;

  for (let i = 0; i < opts.items.length; i++) {
    const item = opts.items[i];
    const tag = multi ? `[#${i + 1} ${item.adName}] ` : "";
    let creativeId: string | null = null;

    if (item.creative.type === "existing") {
      creativeId = item.creative.creativeId;
      opts.steps.push({ step: "creative", id: creativeId, ok: true, note: `${tag}memakai kreatif yang sudah ada` });
    } else {
      const c = item.creative;
      const args: Record<string, unknown> = { ...base, page_id: opts.pageId, name: `${item.adName} · kreatif` };
      if (opts.instagramUserId) args.instagram_user_id = opts.instagramUserId;
      if (c.type === "post") {
        args.object_story_id = c.objectStoryId;
      } else {
        if (c.videoId) args.video_id = c.videoId;
        if (c.imageHash) args.image_hash = c.imageHash;
        if (c.imageUrl) args.image_url = c.imageUrl;
        const vt = opts.thumbs.get(i);
        if (vt) args.image_url = vt;
        args.message = c.primaryText;
        args.headline = c.headline;
        args.call_to_action_type = c.cta;
        if (c.description) args.description = c.description;
        const finalLink = buildFinalLink(item.linkUrl ?? opts.defaultLinkUrl, opts.autoUtm, opts.campaignName, item.adName);
        if (c.cta !== "WHATSAPP_MESSAGE" && finalLink) args.link_url = finalLink;
      }
      let cr: any;
      try { cr = await callTool("ads_create_creative", args, opts.ctx); }
      catch (e) { opts.steps.push({ step: "creative", ok: false, note: explain(`${tag}${(e as Error).message}`).slice(0, 700) }); return { ok: false, creativeIds, adIds }; }
      creativeId = idOf(cr, "creative_id");
      if (!creativeId) { opts.steps.push({ step: "creative", ok: false, note: `${tag}Meta tidak mengembalikan ID kreatif` }); return { ok: false, creativeIds, adIds }; }
      const warn = unwrap(cr.warnings);
      opts.steps.push({ step: "creative", id: creativeId, ok: true, note: warn ? `${tag}peringatan Meta: ${JSON.stringify(warn).slice(0, 300)}` : (multi ? `${tag}dibuat` : undefined) });
    }
    creativeIds.push(creativeId);

    let ad: any;
    try {
      ad = await callTool("ads_create_ad", {
        ...base, ad_set_id: opts.adsetId, ad_name: item.adName, creative: JSON.stringify({ creative_id: creativeId }),
      }, opts.ctx);
    } catch (e) {
      opts.steps.push({ step: "ad", ok: false, note: explain(`${tag}${(e as Error).message}`).slice(0, 700) });
      return { ok: false, creativeIds, adIds };
    }
    const adId = idOf(ad, "ad_id");
    const adErr = errorsOf(ad) ?? (adId ? null : `${tag}Meta tidak mengembalikan ID iklan`);
    opts.steps.push({ step: "ad", id: adId ?? undefined, ok: !adErr, note: adErr ? explain(adErr).slice(0, 700) : (multi ? `${tag}siap` : undefined) });
    if (adErr || !adId) return { ok: false, creativeIds, adIds };
    adIds.push(adId);
  }
  return { ok: true, creativeIds, adIds };
}

/** Jalankan peluncuran kampanye baru (1–5 iklan dalam 1 ad set CBO Advantage+). */
export async function executeLaunch(p: LaunchPlan): Promise<LaunchResult> {
  const ctx = { conv: conversationId(), ...job(`luncurkan kampanye ${p.campaignName}`) };
  const spec = objectiveSpec(p);
  const items = planAds(p);
  const out: LaunchResult = { campaignId: null, adsetId: null, creativeId: null, adId: null, creativeIds: [], adIds: [], published: false, steps: [] };
  const fail = (step: LaunchStep["step"], note: string) => { out.steps.push({ step, ok: false, note: explain(note).slice(0, 700) }); return out; };
  const base = { ad_account_id: p.accountId };

  // 0) Cek kesiapan semua video sebelum membuat entitas apa pun di Meta.
  const vt = await resolveVideoThumbs(p.accountId, items);
  if (!vt.ok) return fail("creative", vt.note);

  // 1) Kampanye (CBO, lowest cost) — budget di level kampanye sesuai rekomendasi Meta.
  let camp: any;
  try {
    camp = await callTool("ads_create_campaign", {
      ...base, campaign_name: p.campaignName, objective: spec.objective, buying_type: "AUCTION", special_ad_categories: "[]",
      campaign_daily_budget: p.dailyBudget, campaign_bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    }, ctx);
  } catch (e) { return fail("campaign", (e as Error).message); }
  out.campaignId = idOf(camp, "campaign_id");
  if (!out.campaignId) return fail("campaign", "Meta tidak mengembalikan ID kampanye");
  const campErr = errorsOf(camp);
  out.steps.push({ step: "campaign", id: out.campaignId, ok: !campErr, note: campErr ?? undefined });
  if (campErr) return out;

  // 2) Ad set: Advantage+ Audience & placements (default server), goal dari daftar valid Meta.
  const valid: string[] = unwrap(camp.valid_optimization_goals) ?? [];
  const goal = !valid.length || valid.includes(spec.goal) ? spec.goal : (camp.recommended_optimization_goal ?? valid[0]);
  const targeting: Record<string, unknown> = { geo_locations: { countries: p.targeting.countries }, age_min: p.targeting.ageMin, age_max: p.targeting.ageMax };
  if (p.targeting.genders !== "all") targeting.genders = [p.targeting.genders === "male" ? 1 : 2];
  let adset: any;
  try {
    adset = await callTool("ads_create_ad_set", {
      ...base, campaign_id: out.campaignId, ad_set_name: `${p.campaignName} · ${p.targeting.countries.join(",")} ${p.targeting.ageMin}-${p.targeting.ageMax}`,
      billing_event: "IMPRESSIONS", optimization_goal: goal, destination_type: spec.destination, targeting: JSON.stringify(targeting),
      ...(spec.promoted ? { promoted_object: JSON.stringify(spec.promoted) } : {}),
    }, ctx);
  } catch (e) { return fail("adset", (e as Error).message); }
  out.adsetId = idOf(adset, "ad_set_id", "adset_id");
  const adsetErr = errorsOf(adset) ? explain(errorsOf(adset)!) : out.adsetId ? null : "Meta tidak mengembalikan ID ad set";
  out.steps.push({ step: "adset", id: out.adsetId ?? undefined, ok: !adsetErr, note: adsetErr ?? (goal !== spec.goal ? `optimization_goal disesuaikan Meta ke ${goal}` : undefined) });
  if (adsetErr || !out.adsetId) return out;

  // 3 & 4) Buat 1–5 pasangan Kreatif + Iklan di dalam ad set tersebut.
  const created = await createAdsInAdset({
    accountId: p.accountId, adsetId: out.adsetId, campaignName: p.campaignName,
    pageId: p.pageId, instagramUserId: p.instagramUserId, defaultLinkUrl: p.linkUrl, autoUtm: p.autoUtm,
    items, thumbs: vt.thumbs, ctx, steps: out.steps,
  });
  out.creativeIds = created.creativeIds;
  out.adIds = created.adIds;
  out.creativeId = created.creativeIds[0] ?? null;
  out.adId = created.adIds[0] ?? null;
  if (!created.ok) return out;

  // 5) Publish (tayang) hanya kalau semua langkah di atas bersih dan user memilih langsung tayang.
  if (!p.startNow) {
    out.steps.push({ step: "publish", ok: true, note: "disimpan sebagai draft di Ads Manager (belum tayang)" });
    return out;
  }
  try {
    const pub = await callTool("ads_activate_entity", {
      ...base, entity_id: out.campaignId, entity_type: "campaign", object_ids: [out.campaignId], publish_as_active: true,
    }, ctx);
    const pubErr = errorsOf(pub);
    out.published = !pubErr;
    out.steps.push({ step: "publish", ok: !pubErr, note: pubErr ?? undefined });
  } catch (e) { return fail("publish", (e as Error).message); }
  return out;
}

/** Jalankan penambahan 1–5 iklan baru ke dalam kampanye / ad set yang sudah ada. */
export async function executeAddAds(p: AddAdsPlan & { adsetId: string }): Promise<LaunchResult> {
  const ctx = { conv: conversationId(), ...job(`tambah ${p.ads.length} iklan ke ${p.campaignName ?? p.campaignId}`) };
  const out: LaunchResult = {
    campaignId: p.campaignId, adsetId: p.adsetId, creativeId: null, adId: null, creativeIds: [], adIds: [], published: false, steps: [],
  };
  const fail = (step: LaunchStep["step"], note: string) => { out.steps.push({ step, ok: false, note: explain(note).slice(0, 700) }); return out; };

  const vt = await resolveVideoThumbs(p.accountId, p.ads);
  if (!vt.ok) return fail("creative", vt.note);

  const created = await createAdsInAdset({
    accountId: p.accountId, adsetId: p.adsetId, campaignName: p.campaignName ?? p.campaignId,
    pageId: p.pageId, instagramUserId: p.instagramUserId, defaultLinkUrl: p.linkUrl, autoUtm: p.autoUtm,
    items: p.ads, thumbs: vt.thumbs, ctx, steps: out.steps,
  });
  out.creativeIds = created.creativeIds;
  out.adIds = created.adIds;
  out.creativeId = created.creativeIds[0] ?? null;
  out.adId = created.adIds[0] ?? null;
  if (!created.ok) return out;

  if (!p.startNow) {
    out.steps.push({ step: "publish", ok: true, note: "iklan baru disimpan sebagai draft di ad set tujuan" });
    return out;
  }
  try {
    for (const adId of created.adIds) {
      const pub = await callTool("ads_activate_entity", {
        ad_account_id: p.accountId, entity_id: adId, entity_type: "ad", object_ids: [adId], publish_as_active: true,
      }, ctx);
      const pubErr = errorsOf(pub);
      if (pubErr) return fail("publish", pubErr);
    }
    out.published = true;
    out.steps.push({ step: "publish", ok: true, note: `${created.adIds.length} iklan diaktifkan di ad set` });
  } catch (e) { return fail("publish", (e as Error).message); }
  return out;
}

/** Hentikan kampanye hasil peluncuran (dipakai tombol "Batalkan aksi"). */
export async function pauseLaunched(accountId: string, campaignId: string) {
  const ctx = { conv: conversationId(), job: "update_existing_campaigns" as const, request: "pause kampanye baru" };
  return callTool("ads_update_entity", { ad_account_id: accountId, entity_id: campaignId, entity_type: "campaign", fields: JSON.stringify({ status: "PAUSED" }) }, ctx);
}

/** Hentikan iklan-iklan yang baru disuntikkan ke ad set (dipakai tombol "Batalkan aksi" untuk add_ads). */
export async function pauseAddedAds(accountId: string, adIds: string[]) {
  const ctx = { conv: conversationId(), job: "update_existing_campaigns" as const, request: "pause iklan baru" };
  const out: unknown[] = [];
  for (const adId of adIds) {
    out.push(await callTool("ads_update_entity", { ad_account_id: accountId, entity_id: adId, entity_type: "ad", fields: JSON.stringify({ status: "PAUSED" }) }, ctx));
  }
  return out;
}
