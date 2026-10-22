// Buat & luncurkan kampanye Meta dari chat (lewat MCP Meta Ads), dengan guardrail dan konfirmasi user.
// Alur: bot mengusulkan rencana (validasi di sini) → kartu konfirmasi → confirmAction() menjalankan executeLaunch():
// kampanye (CBO) → ad set → kreatif → iklan, semuanya sebagai DRAFT; berhenti di langkah pertama yang gagal (tanpa biaya);
// baru di-publish (tayang) kalau semua langkah bersih dan user memilih langsung tayang.
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { metaMode } from "../env";
import { sql } from "../db";
import { loadConfig, type Config } from "../scope";
import { callTool, conversationId, unwrap } from "./mcp";
import { videoStatus } from "./upload";

export const LAUNCH_OBJECTIVES = ["sales", "leads_website", "leads_whatsapp", "traffic"] as const;
export const LAUNCH_CTAS = ["SHOP_NOW", "BUY_NOW", "LEARN_MORE", "SIGN_UP", "ORDER_NOW", "GET_OFFER", "CONTACT_US", "APPLY_NOW", "SUBSCRIBE", "WHATSAPP_MESSAGE"] as const;

export const launchPlanSchema = z.object({
  accountId: z.string().regex(/^\d{5,25}$/),
  campaignName: z.string().trim().min(3).max(120),
  objective: z.enum(LAUNCH_OBJECTIVES),
  dailyBudget: z.number().int().positive(),
  pageId: z.string().regex(/^\d+$/),
  instagramUserId: z.string().regex(/^\d+$/).optional(),
  pixelId: z.string().regex(/^\d+$/).optional(),
  linkUrl: z.string().url().optional(),
  targeting: z.object({
    countries: z.array(z.string().length(2)).min(1).max(10).default(["ID"]),
    ageMin: z.number().int().min(18).max(65).default(18),
    ageMax: z.number().int().min(18).max(65).default(65),
    genders: z.enum(["all", "male", "female"]).default("all"),
  }).default({}),
  creative: z.discriminatedUnion("type", [
    z.object({ type: z.literal("existing"), creativeId: z.string().regex(/^\d+$/) }),
    z.object({ type: z.literal("post"), objectStoryId: z.string().regex(/^\d+_\d+$/) }),
    z.object({
      type: z.literal("new"),
      imageHash: z.string().optional(), imageUrl: z.string().url().optional(), videoId: z.string().regex(/^\d+$/).optional(),
      primaryText: z.string().trim().min(10).max(2000), headline: z.string().trim().min(2).max(120), description: z.string().max(200).optional(),
      cta: z.enum(LAUNCH_CTAS).default("LEARN_MORE"),
    }),
  ]),
  adName: z.string().trim().min(3).max(120),
  startNow: z.boolean().default(true),
  rationale: z.string().max(1500).optional(),
});
export type LaunchPlan = z.infer<typeof launchPlanSchema>;

export interface LaunchStep { step: "campaign" | "adset" | "creative" | "ad" | "publish"; id?: string; ok: boolean; note?: string }
export interface LaunchResult { campaignId: string | null; adsetId: string | null; creativeId: string | null; adId: string | null; published: boolean; steps: LaunchStep[] }

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
export async function validateLaunchPlan(raw: unknown): Promise<{ plan: LaunchPlan; accountName: string; minDaily: number; maxDaily: number }> {
  if (metaMode() !== "mcp") throw new Error("Peluncuran iklan butuh jalur MCP Meta (login Claude Code di VPS). Jalur Graph API belum mendukung pembuatan iklan.");
  const parsed = launchPlanSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Rencana belum lengkap/valid: " + JSON.stringify(parsed.error.flatten().fieldErrors));
  const plan = parsed.data;
  const cfg = await loadConfig();
  const { acc, minDaily, maxDaily } = await accountLimits(plan.accountId, cfg);
  if (plan.dailyBudget < minDaily) throw new Error(`Budget harian minimal akun ini Rp${minDaily.toLocaleString("id-ID")}.`);
  if (plan.dailyBudget > maxDaily) throw new Error(`Budget harian melebihi batas aman Rp${maxDaily.toLocaleString("id-ID")}/hari. Minta user menaikkan "budget harian maksimal" di Pengaturan akun kalau memang mau lebih.`);
  if (plan.targeting.ageMin > plan.targeting.ageMax) throw new Error("ageMin harus ≤ ageMax");
  const web = plan.objective !== "leads_whatsapp";
  if ((plan.objective === "sales" || plan.objective === "leads_website") && !plan.pixelId) throw new Error("Tujuan ini butuh pixel (dataset) untuk mengukur konversi. Ambil dari get_launch_context.");
  if (web && plan.creative.type === "new" && !plan.linkUrl) throw new Error("Iklan ke website butuh linkUrl (halaman produk/landing page).");
  if (plan.creative.type === "new") {
    const c = plan.creative;
    if (!c.imageHash && !c.imageUrl && !c.videoId) throw new Error("Kreatif baru butuh gambar (imageHash/imageUrl) atau videoId.");
    if (c.imageHash && c.imageUrl) throw new Error("Pilih salah satu: imageHash atau imageUrl.");
    if (plan.objective === "leads_whatsapp" && c.cta !== "WHATSAPP_MESSAGE") throw new Error("Iklan WhatsApp wajib CTA WHATSAPP_MESSAGE.");
    if (plan.objective !== "leads_whatsapp" && c.cta === "WHATSAPP_MESSAGE") throw new Error("CTA WHATSAPP_MESSAGE hanya untuk tujuan leads_whatsapp.");
  }
  return { plan, accountName: acc.name, minDaily, maxDaily };
}

/** Bahan untuk merancang iklan: Page, IG, pixel, kreatif yang sudah ada, kampanye terbaik 30 hari, produk lynk. */
export async function launchContext(accountId: string) {
  if (metaMode() !== "mcp") return { error: "Peluncuran iklan butuh jalur MCP Meta." };
  const cfg = await loadConfig();
  const { acc, minDaily, maxDaily } = await accountLimits(accountId, cfg);
  const ctx = { conv: conversationId(), ...job("siapkan aset untuk iklan baru") };
  const safe = async <T>(p: Promise<T>): Promise<T | { error: string }> => p.catch((e) => ({ error: (e as Error).message.slice(0, 200) }));
  const [pages, ig, datasets, creatives, top] = await Promise.all([
    safe(callTool("ads_get_ad_account_pages", { ad_account_id: accountId, limit: 10 }, ctx)),
    safe(callTool("ads_get_ig_accounts", { ad_account_id: accountId, limit: 10 }, ctx)),
    safe(callTool("ads_get_datasets", { ad_account_id: accountId, limit: 10 }, ctx)),
    safe(callTool("ads_get_creatives", { ad_account_id: accountId, limit: 12, fields: ["id", "name", "status", "body", "title", "call_to_action_type", "object_story_id", "image_hash", "video_id", "link_url"] }, ctx)),
    sql`
      SELECT c.name, c.status, SUM(d.spend)::bigint AS spend, SUM(d.purchases)::int AS purchases, SUM(d.leads)::int AS leads,
             SUM(d.purchase_value)::bigint AS value
      FROM campaign_daily d JOIN campaigns c ON c.id = d.campaign_id
      WHERE d.account_id = ${accountId} AND d.date >= (now() AT TIME ZONE 'Asia/Jakarta')::date - 30
      GROUP BY c.id ORDER BY SUM(d.spend) DESC LIMIT 6`,
  ]);
  const products = await sql`SELECT name, price, url FROM products WHERE active AND line = ${acc.line} ORDER BY name LIMIT 20`;
  return {
    account: { id: acc.id, name: acc.name, line: acc.line, currency: "IDR", minDailyBudget: minDaily, maxDailyBudget: maxDaily, targetRoas: acc.settings.targetRoas, maxCpa: acc.settings.maxCpa, maxCpl: acc.settings.maxCpl },
    pages: unwrap((pages as any).pages ?? (pages as any).data ?? pages),
    instagramAccounts: unwrap((ig as any).ig_accounts ?? (ig as any).instagram_accounts ?? (ig as any).data ?? ig),
    pixels: unwrap((datasets as any).datasets ?? (datasets as any).data ?? datasets),
    existingCreatives: unwrap((creatives as any).ad_creatives ?? (creatives as any).creatives ?? creatives),
    topCampaigns30d: top.map((r) => ({ ...r, roas: r.spend ? Math.round((Number(r.value) / Number(r.spend)) * 100) / 100 : 0 })),
    products: products.map((p) => ({ name: p.name, price: p.price, url: p.url })),
  };
}

function objectiveSpec(p: LaunchPlan) {
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
  return note;
}

const needsVideoThumb = (p: LaunchPlan) => p.creative.type === "new" && !!p.creative.videoId && !p.creative.imageHash && !p.creative.imageUrl;

/**
 * Dipanggil sebelum konfirmasi diklaim: video yang masih diproses Meta ditolak dengan 409 supaya user cukup menekan
 * "Ya, eksekusi" lagi nanti, tanpa aksi hangus dan tanpa kampanye setengah jadi.
 */
export async function assertLaunchMediaReady(p: LaunchPlan) {
  if (!needsVideoThumb(p) || p.creative.type !== "new") return;
  const v = await videoStatus(p.accountId, p.creative.videoId!);
  if (v.status === "error") throw new HTTPException(409, { message: "Meta gagal memproses video ini. Upload ulang videonya lewat chat." });
  if (v.status !== "ready" || !v.picture) {
    throw new HTTPException(409, { message: `Video masih diproses Meta${v.progress != null ? ` (${v.progress}%)` : ""}. Tunggu 1–2 menit lalu tekan "Ya, eksekusi" lagi.` });
  }
}

/** Jalankan peluncuran. Tidak melempar error: hasil per langkah dikembalikan supaya bisa dicatat & ditampilkan. */
export async function executeLaunch(p: LaunchPlan): Promise<LaunchResult> {
  const ctx = { conv: conversationId(), ...job(`luncurkan kampanye ${p.campaignName}`) };
  const spec = objectiveSpec(p);
  const out: LaunchResult = { campaignId: null, adsetId: null, creativeId: null, adId: null, published: false, steps: [] };
  const fail = (step: LaunchStep["step"], note: string) => { out.steps.push({ step, ok: false, note: explain(note).slice(0, 700) }); return out; };
  const base = { ad_account_id: p.accountId };

  // 0) Iklan video wajib punya thumbnail: pakai thumbnail buatan Meta. Dicek sebelum membuat apa pun.
  let videoThumb: string | null = null;
  if (needsVideoThumb(p) && p.creative.type === "new") {
    try {
      const v = await videoStatus(p.accountId, p.creative.videoId!);
      if (v.status !== "ready" || !v.picture) return fail("creative", `Video belum siap dipakai (status ${v.status}). Tidak ada yang dibuat.`);
      videoThumb = v.picture;
    } catch (e) { return fail("creative", `Gagal cek video: ${(e as Error).message}`); }
  }

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
  if (adsetErr) return out;

  // 3) Kreatif (atau pakai yang sudah ada / boost postingan).
  let creativeSpec: Record<string, string>;
  if (p.creative.type === "existing") {
    out.creativeId = p.creative.creativeId;
    creativeSpec = { creative_id: p.creative.creativeId };
    out.steps.push({ step: "creative", id: out.creativeId, ok: true, note: "memakai kreatif yang sudah ada" });
  } else {
    const c = p.creative;
    const args: Record<string, unknown> = { ...base, page_id: p.pageId, name: `${p.adName} · kreatif` };
    if (p.instagramUserId) args.instagram_user_id = p.instagramUserId;
    if (c.type === "post") args.object_story_id = c.objectStoryId;
    else {
      if (c.videoId) args.video_id = c.videoId;
      if (c.imageHash) args.image_hash = c.imageHash;
      if (c.imageUrl) args.image_url = c.imageUrl;
      if (videoThumb) args.image_url = videoThumb;
      args.message = c.primaryText; args.headline = c.headline; args.call_to_action_type = c.cta;
      if (c.description) args.description = c.description;
      if (c.cta !== "WHATSAPP_MESSAGE" && p.linkUrl) args.link_url = p.linkUrl;
    }
    let cr: any;
    try { cr = await callTool("ads_create_creative", args, ctx); } catch (e) { return fail("creative", (e as Error).message); }
    out.creativeId = idOf(cr, "creative_id");
    if (!out.creativeId) return fail("creative", "Meta tidak mengembalikan ID kreatif");
    const warn = unwrap(cr.warnings);
    out.steps.push({ step: "creative", id: out.creativeId, ok: true, note: warn ? `peringatan Meta: ${JSON.stringify(warn).slice(0, 300)}` : undefined });
    creativeSpec = { creative_id: out.creativeId };
  }

  // 4) Iklan.
  let ad: any;
  try { ad = await callTool("ads_create_ad", { ...base, ad_set_id: out.adsetId, ad_name: p.adName, creative: JSON.stringify(creativeSpec) }, ctx); }
  catch (e) { return fail("ad", (e as Error).message); }
  out.adId = idOf(ad, "ad_id");
  const adErr = errorsOf(ad) ?? (out.adId ? null : "Meta tidak mengembalikan ID iklan");
  out.steps.push({ step: "ad", id: out.adId ?? undefined, ok: !adErr, note: adErr ?? undefined });
  if (adErr) return out;

  // 5) Publish (tayang) hanya kalau semua bersih dan user memilih langsung tayang.
  if (!p.startNow) { out.steps.push({ step: "publish", ok: true, note: "disimpan sebagai draft di Ads Manager (belum tayang)" }); return out; }
  try {
    const pub = await callTool("ads_activate_entity", { ...base, entity_id: out.campaignId, entity_type: "campaign", object_ids: [out.campaignId], publish_as_active: true }, ctx);
    const pubErr = errorsOf(pub);
    out.published = !pubErr;
    out.steps.push({ step: "publish", ok: !pubErr, note: pubErr ?? undefined });
  } catch (e) { return fail("publish", (e as Error).message); }
  return out;
}

/** Hentikan kampanye hasil peluncuran (dipakai tombol "Batalkan aksi"). */
export async function pauseLaunched(accountId: string, campaignId: string) {
  const ctx = { conv: conversationId(), job: "update_existing_campaigns" as const, request: "pause kampanye baru" };
  return callTool("ads_update_entity", { ad_account_id: accountId, entity_id: campaignId, entity_type: "campaign", fields: JSON.stringify({ status: "PAUSED" }) }, ctx);
}

