// Aksi kampanye & iklan (pause / pause_ad / aktifkan / scale / launch / add_ads).
// Dari chat & tabel: membuat aksi pending yang dikonfirmasi owner, kecuali owner menyuruh bot langsung menayangkan iklan (executeNow).
// Dari Autopilot: membuat pending (mode suggest) atau langsung mengeksekusi atomik (mode auto, setelah lolos semua guardrail).
import { HTTPException } from "hono/http-exception";
import { rp, type BotAction } from "@iklan/shared";
import { sql, bumpDataVersion } from "./db";
import { metaConfigured, metaMode } from "./env";
import { fetchActiveAdsets, fetchCampaignState, setAdStatus, setDailyBudget, setStatus } from "./meta/ops";
import { emit } from "./events";
import { errMsg, log } from "./log";
import { loadConfig } from "./scope";
import {
  addAdsPlanSchema, assertAdsMediaReady, assertLaunchMediaReady, auditLaunchPlan, executeAddAds, executeLaunch,
  launchPlanSchema, pauseAddedAds, pauseLaunched, planAds, validateAddAdsPlan, validateLaunchPlan,
  type AddAdsPlan, type LaunchPlan, type LaunchResult,
} from "./meta/launch";
import { runSync } from "./meta/sync";

export type CampaignAction = "pause" | "activate" | "scale";
export type ActionSource = "chat" | "table" | "rule_engine" | "autopilot";
const MAX_SCALE_PCT = 50;
const EXPIRE_MIN = 10;
const AUTOPILOT_EXPIRE_MIN = 720; // 12 jam untuk usulan mode suggest dari Autopilot

interface AdsetBudget { id: string; name: string; before: number; after: number }
interface Params {
  before: { status: string; dailyBudget: number | null };
  after: { status: string; dailyBudget: number | null };
  pct?: number;
  adsets?: AdsetBudget[];
  demo?: boolean;
  field?: string; value?: number; previous?: number | null;
}

const actionSelect = () => sql`
  SELECT b.id, b.account_id, a.display_name AS account_name, b.campaign_id, c.name AS campaign_name, b.action, b.params,
         b.source, b.status, b.reason, b.error, b.created_at, b.expires_at, b.executed_at
  FROM bot_actions b
  LEFT JOIN ad_accounts a ON a.id = b.account_id
  LEFT JOIN campaigns c ON c.id = b.campaign_id`;

export function toAction(r: any): BotAction {
  return {
    id: Number(r.id), accountId: r.account_id, accountName: r.account_name, campaignId: r.campaign_id, campaignName: r.campaign_name,
    action: r.action, params: r.params, source: r.source,
    status: r.status === "pending" && r.expires_at && new Date(r.expires_at) < new Date() ? "expired" : r.status,
    reason: r.reason, error: r.error, createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at?.toISOString() ?? null, executedAt: r.executed_at?.toISOString() ?? null,
  };
}

export async function getAction(id: number): Promise<BotAction> {
  const [r] = await sql`${actionSelect()} WHERE b.id = ${id}`;
  if (!r) throw new HTTPException(404, { message: "Aksi tidak ditemukan" });
  return toAction(r);
}

/** Cari kampanye dari potongan nama (skor = jumlah kata yang cocok), seperti findCampaign() di prototipe. */
const STOP = new Set(["pause", "matikan", "stop", "jeda", "aktifkan", "nyalakan", "hidupkan", "jalankan", "scale", "naikkan", "naikin",
  "budget", "kampanye", "campaign", "iklan", "yang", "itu", "dong", "tolong", "please", "akun", "the", "dan"]);
export async function findCampaigns(query: string, accountIds: string[]) {
  const toks = query.toLowerCase().split(/[^a-z0-9%+.]+/).filter((w) => w.length > 1 && !STOP.has(w));
  if (!toks.length || !accountIds.length) return [];
  const rows = await sql`
    SELECT c.id, c.name, c.status, c.account_id, c.daily_budget, a.display_name AS account_name
    FROM campaigns c JOIN ad_accounts a ON a.id = c.account_id
    WHERE c.account_id = ANY(${accountIds}) AND c.status <> 'ARCHIVED' AND c.status <> 'DELETED'`;
  return rows
    .map((r) => {
      const n = (r.name as string).toLowerCase();
      return {
        id: r.id as string, name: r.name as string, status: r.status as string, account_id: r.account_id as string,
        account_name: r.account_name as string, score: toks.filter((w) => n.includes(w)).length + (r.status === "ACTIVE" ? 0.1 : 0),
      };
    })
    .filter((r) => r.score >= 1)
    .sort((a, b) => b.score - a.score);
}

export async function createCampaignAction(opts: {
  campaignId: string; action: CampaignAction; pct?: number; source: ActionSource; userId: number | null; reason?: string;
}): Promise<BotAction> {
  const [c] = await sql`SELECT id, account_id, name, status, daily_budget, is_cbo FROM campaigns WHERE id = ${opts.campaignId}`;
  if (!c) throw new HTTPException(404, { message: "Kampanye tidak ditemukan" });
  const cfg = await loadConfig();
  const acc = cfg.accounts.find((a) => a.id === c.account_id)!;
  const live = metaConfigured();

  let status = c.status as string, daily: number | null = c.daily_budget != null ? Number(c.daily_budget) : null;
  if (live) {
    const fresh = await fetchCampaignState(c.account_id, c.id);
    status = fresh.status; daily = fresh.dailyBudget;
  }
  const params: Params = { before: { status, dailyBudget: daily }, after: { status, dailyBudget: daily }, demo: !live };

  if (opts.action === "pause") {
    if (status === "PAUSED") throw new HTTPException(409, { message: `${c.name} sudah dalam status jeda` });
    params.after.status = "PAUSED";
  } else if (opts.action === "activate") {
    if (status === "ACTIVE") throw new HTTPException(409, { message: `${c.name} sudah aktif` });
    params.after.status = "ACTIVE";
  } else {
    const pct = Math.min(Math.max(opts.pct ?? acc.settings.scaleStepPct, 1), MAX_SCALE_PCT);
    params.pct = pct;
    const cap = acc.settings.maxDailyBudget;
    const up = (v: number) => {
      const next = Math.round(v * (1 + pct / 100));
      return cap ? Math.min(next, cap) : next;
    };
    if (daily) params.after.dailyBudget = up(daily);
    else if (live) {
      // ABO: budget ada di level ad set.
      const adsets = await fetchActiveAdsets(c.account_id, c.id);
      params.adsets = adsets.map((a) => ({ id: a.id, name: a.name, before: a.budget, after: up(a.budget) }));
      if (!params.adsets.length) throw new HTTPException(409, { message: "Kampanye ini tidak punya budget harian yang bisa dinaikkan" });
    } else throw new HTTPException(409, { message: "Budget harian kampanye ini belum diketahui" });
  }

  const expireMin = opts.source === "autopilot" ? AUTOPILOT_EXPIRE_MIN : EXPIRE_MIN;
  const [row] = await sql`
    INSERT INTO bot_actions (account_id, campaign_id, action, params, source, status, reason, requested_by, expires_at)
    VALUES (${c.account_id}, ${c.id}, ${opts.action}, ${sql.json(params as any)}, ${opts.source}::action_source, 'pending', ${opts.reason ?? null},
            ${opts.userId}, now() + make_interval(mins => ${expireMin}))
    RETURNING id`;
  return getAction(Number(row.id));
}

/** Matikan 1 iklan spesifik yang boncos di dalam kampanye tanpa mematikan iklan lain yang masih sehat. */
export async function createPauseAdAction(opts: {
  accountId: string; campaignId: string | null; adId: string; adName: string; source: ActionSource; userId: number | null; reason?: string;
}): Promise<BotAction> {
  const live = metaConfigured();
  const params = {
    adId: opts.adId,
    adName: opts.adName,
    before: { status: "ACTIVE" },
    after: { status: "PAUSED" },
    demo: !live,
  };
  const expireMin = opts.source === "autopilot" ? AUTOPILOT_EXPIRE_MIN : EXPIRE_MIN;
  const [row] = await sql`
    INSERT INTO bot_actions (account_id, campaign_id, action, params, source, status, reason, requested_by, expires_at)
    VALUES (${opts.accountId}, ${opts.campaignId}, 'pause_ad', ${sql.json(params as any)}, ${opts.source}::action_source, 'pending', ${opts.reason ?? null},
            ${opts.userId}, now() + make_interval(mins => ${expireMin}))
    RETURNING id`;
  return getAction(Number(row.id));
}

/** Usulan peluncuran kampanye baru dari bot atau autopilot. */
export async function createLaunchAction(raw: unknown, userId: number | null, reason?: string, source: ActionSource = "chat", opts?: { autoExecute?: boolean }): Promise<BotAction> {
  let params: Record<string, unknown>;
  let accountId: string;
  let finalReason = reason ?? null;
  if (source === "autopilot" && !metaConfigured()) {
    const plan = launchPlanSchema.parse(raw);
    const cfg = await loadConfig();
    const acc = cfg.accounts.find((a) => a.id === plan.accountId && a.active);
    if (!acc) throw new Error("Akun iklan tidak aktif");
    const targetCpa = acc.line === "jasa" ? acc.settings.maxCpl : acc.settings.maxCpa;
    const audit = auditLaunchPlan({ objective: plan.objective, dailyBudget: plan.dailyBudget, linkUrl: plan.linkUrl, ads: planAds(plan) }, { targetCpa, line: acc.line });
    accountId = plan.accountId;
    finalReason = finalReason ?? plan.rationale ?? null;
    params = { plan, accountName: acc.name, limits: { minDaily: 0, maxDaily: acc.settings.maxDailyBudget || null }, audit, demo: true };
  } else {
    const v = await validateLaunchPlan(raw);
    accountId = v.plan.accountId;
    finalReason = finalReason ?? v.plan.rationale ?? null;
    params = { plan: v.plan, accountName: v.accountName, limits: { minDaily: v.minDaily, maxDaily: v.maxDaily }, audit: v.audit };
  }
  if (opts?.autoExecute) params.autoExecute = true;
  const expireMin = source === "autopilot" ? AUTOPILOT_EXPIRE_MIN : LAUNCH_EXPIRE_MIN;
  const [row] = await sql`
    INSERT INTO bot_actions (account_id, action, params, source, status, reason, requested_by, expires_at)
    VALUES (${accountId}, 'launch', ${sql.json(params as any)}, ${source}::action_source, 'pending', ${finalReason}, ${userId},
            now() + make_interval(mins => ${expireMin}))
    RETURNING id`;
  return getAction(Number(row.id));
}

/** Usulan penambahan 1–5 iklan baru ke kampanye / ad set yang sudah ada. */
export async function createAddAdsAction(raw: unknown, userId: number | null, reason?: string, source: ActionSource = "chat", opts?: { autoExecute?: boolean }): Promise<BotAction> {
  let params: Record<string, unknown>;
  let accountId: string;
  let campaignId: string;
  let finalReason = reason ?? null;
  if (source === "autopilot" && !metaConfigured()) {
    const plan = addAdsPlanSchema.parse(raw);
    const cfg = await loadConfig();
    const acc = cfg.accounts.find((a) => a.id === plan.accountId && a.active);
    if (!acc) throw new Error("Akun iklan tidak aktif");
    const [campRow] = await sql`SELECT id, name FROM campaigns WHERE id = ${plan.campaignId} AND account_id = ${plan.accountId}`;
    const campaignName = campRow?.name ?? plan.campaignName ?? `Kampanye #${plan.campaignId}`;
    const adsetId = plan.adsetId ?? `demo_adset_${plan.campaignId}`;
    const targetCpa = acc.line === "jasa" ? acc.settings.maxCpl : acc.settings.maxCpa;
    const audit = auditLaunchPlan({ objective: plan.objective, linkUrl: plan.linkUrl, ads: plan.ads }, { targetCpa, line: acc.line });
    accountId = plan.accountId;
    campaignId = plan.campaignId;
    finalReason = finalReason ?? plan.rationale ?? null;
    params = { plan: { ...plan, campaignName, adsetId }, accountName: acc.name, campaignName, adsetId, adsetName: "Ad Set Utama", audit, demo: true };
  } else {
    const v = await validateAddAdsPlan(raw);
    accountId = v.plan.accountId;
    campaignId = v.plan.campaignId;
    finalReason = finalReason ?? v.plan.rationale ?? null;
    params = { plan: v.plan, accountName: v.accountName, campaignName: v.campaignName, adsetId: v.adsetId, adsetName: v.adsetName, audit: v.audit };
  }
  if (opts?.autoExecute) params.autoExecute = true;
  const expireMin = source === "autopilot" ? AUTOPILOT_EXPIRE_MIN : LAUNCH_EXPIRE_MIN;
  const [row] = await sql`
    INSERT INTO bot_actions (account_id, campaign_id, action, params, source, status, reason, requested_by, expires_at)
    VALUES (${accountId}, ${campaignId}, 'add_ads', ${sql.json(params as any)}, ${source}::action_source, 'pending', ${finalReason}, ${userId},
            now() + make_interval(mins => ${expireMin}))
    RETURNING id`;
  return getAction(Number(row.id));
}
const LAUNCH_EXPIRE_MIN = 30;

/** Kalimat ringkas untuk kartu konfirmasi & log. */
export function describeAction(a: BotAction): string {
  const p = a.params as unknown as Params;
  if (a.action === "pause") return `Pause ${a.campaignName}`;
  if (a.action === "pause_ad") return `Pause iklan ${(a.params as any).adName ?? (a.params as any).adId}`;
  if (a.action === "activate") return `Aktifkan ${a.campaignName}`;
  if (a.action === "scale") {
    if (p.adsets?.length) return `Naikkan budget ${p.pct}% untuk ${p.adsets.length} ad set di ${a.campaignName}`;
    return `Naikkan budget ${a.campaignName} dari ${rp(p.before.dailyBudget ?? 0)} ke ${rp(p.after.dailyBudget ?? 0)}/hari`;
  }
  if (a.action === "update_rule") return `Ubah aturan ${p.field} jadi ${p.value}`;
  if (a.action === "launch") return `Luncurkan kampanye ${(a.params as any).plan?.campaignName}`;
  if (a.action === "add_ads") {
    const n = ((a.params as any).plan?.ads as unknown[] | undefined)?.length ?? 1;
    return `Tambah ${n} iklan baru ke ${a.campaignName ?? (a.params as any).campaignName ?? "kampanye"}`;
  }
  return a.action;
}

async function apply(campaignId: string, p: Params, target: "after" | "before") {
  const want = p[target];
  const other = p[target === "after" ? "before" : "after"];
  const live = metaConfigured() && !p.demo;
  const responses: unknown[] = [];
  if (live) {
    const [{ account_id: accountId }] = await sql`SELECT account_id FROM campaigns WHERE id = ${campaignId}`;
    if (want.status !== other.status) responses.push(await setStatus(accountId, campaignId, want.status as "ACTIVE" | "PAUSED"));
    const wasActive = want.status === "ACTIVE";
    if (p.adsets?.length) {
      for (const s of p.adsets) responses.push(await setDailyBudget(accountId, s.id, "ad_set", target === "after" ? s.after : s.before, wasActive));
    } else if (want.dailyBudget != null && want.dailyBudget !== other.dailyBudget) {
      responses.push(await setDailyBudget(accountId, campaignId, "campaign", want.dailyBudget, wasActive));
    }
  }
  await sql`
    UPDATE campaigns SET status = ${want.status}, effective_status = ${want.status},
      daily_budget = COALESCE(${p.adsets?.length ? null : want.dailyBudget}::bigint, daily_budget), updated_at = now()
    WHERE id = ${campaignId}`;
  return live ? responses : [{ demo: true }];
}

async function applyAdStatus(accountId: string, p: { adId: string; before: { status: string }; after: { status: string }; demo?: boolean }, target: "after" | "before") {
  const want = p[target].status as "ACTIVE" | "PAUSED";
  const live = metaConfigured() && !p.demo;
  if (live) return [await setAdStatus(accountId, p.adId, want)];
  return [{ demo: true, adId: p.adId, status: want }];
}

export async function confirmAction(id: number): Promise<BotAction> {
  const [pre] = await sql`SELECT action, params FROM bot_actions WHERE id = ${id} AND status = 'pending'`;
  if (pre?.action === "launch" && !pre.params?.demo) await assertLaunchMediaReady(pre.params.plan);
  if (pre?.action === "add_ads" && !pre.params?.demo) await assertAdsMediaReady(pre.params.plan.accountId, pre.params.plan.ads);
  // Klaim atomik: expires_at dikosongkan, jadi konfirmasi kedua (klik dobel) tidak lolos lagi.
  const [claimed] = await sql`
    UPDATE bot_actions SET expires_at = NULL
    WHERE id = ${id} AND status = 'pending' AND expires_at > now()
    RETURNING id, account_id, campaign_id, action, params`;
  if (!claimed) {
    const cur = await getAction(id);
    throw new HTTPException(409, { message: cur.status === "expired" ? "Konfirmasi sudah kedaluwarsa, minta ulang ke bot" : "Aksi ini sudah diproses" });
  }
  if (claimed.action === "launch") return confirmLaunch(id, claimed.account_id, claimed.params);
  if (claimed.action === "add_ads") return confirmAddAds(id, claimed.account_id, claimed.params);
  try {
    const resp = claimed.action === "pause_ad"
      ? await applyAdStatus(claimed.account_id, claimed.params, "after")
      : await apply(claimed.campaign_id, claimed.params, "after");
    await sql`UPDATE bot_actions SET status = 'executed', executed_at = now(), meta_response = ${sql.json(resp as any)} WHERE id = ${id}`;
    log.info("aksi dieksekusi", { id, action: claimed.action, campaign: claimed.campaign_id });
  } catch (e) {
    await sql`UPDATE bot_actions SET status = 'failed', error = ${errMsg(e)} WHERE id = ${id}`;
    log.error("aksi gagal", { id, error: errMsg(e) });
  }
  await bumpDataVersion();
  const a = await getAction(id);
  emit({ type: "action", id, status: a.status });
  return a;
}

async function confirmLaunch(id: number, accountId: string, params: { plan: LaunchPlan; demo?: boolean }): Promise<BotAction> {
  const demo = Boolean(params.demo || !metaConfigured());
  const res: LaunchResult = demo
    ? {
        campaignId: `demo_${Date.now()}_${id}`,
        adsetId: `demo_as_${id}`,
        creativeId: `demo_cr_${id}`,
        adId: `demo_ad_${id}`,
        creativeIds: planAds(params.plan).map((_, i) => `demo_cr_${id}_${i + 1}`),
        adIds: planAds(params.plan).map((_, i) => `demo_ad_${id}_${i + 1}`),
        published: params.plan.startNow,
        steps: [
          { step: "campaign", ok: true, note: "simulasi mode demo" },
          { step: "adset", ok: true },
          { step: "creative", ok: true },
          { step: "ad", ok: true },
          { step: "publish", ok: true, note: "tayang simulasi (mode demo)" },
        ],
      }
    : await executeLaunch(params.plan);
  const ok = res.steps.length > 0 && res.steps.every((s) => s.ok);
  const failed = res.steps.find((s) => !s.ok);
  // Kampanye baru dimasukkan ke tabel lokal supaya kartu & log bisa menautkannya sebelum sync berikutnya.
  if (res.campaignId) {
    await sql`
      INSERT INTO campaigns (id, account_id, name, status, effective_status, daily_budget, is_cbo, created_time, updated_at)
      VALUES (${res.campaignId}, ${accountId}, ${params.plan.campaignName}, ${res.published ? "ACTIVE" : "PAUSED"}, ${res.published ? "ACTIVE" : "PAUSED"},
              ${params.plan.dailyBudget}, true, now(), now())
      ON CONFLICT (id) DO NOTHING`;
  }
  await sql`
    UPDATE bot_actions SET status = ${ok ? "executed" : "failed"}::action_status, executed_at = ${ok ? new Date() : null}, campaign_id = ${res.campaignId},
      params = params || ${sql.json({ result: res } as any)}, meta_response = ${sql.json(res as any)},
      error = ${failed ? `Gagal di langkah ${failed.step}: ${failed.note ?? "error dari Meta"}. Objek yang sudah dibuat tetap draft/jeda (tanpa biaya), cek di Ads Manager.` : null}
    WHERE id = ${id}`;
  log[ok ? "info" : "error"]("peluncuran kampanye", { id, ok, campaign: res.campaignId, published: res.published, failedStep: failed?.step, demo });
  if (res.published && metaMode() === "mcp" && !demo) void runSync("manual", accountId).catch(() => {});
  await bumpDataVersion();
  const a = await getAction(id);
  emit({ type: "action", id, status: a.status });
  return a;
}

async function confirmAddAds(id: number, accountId: string, params: { plan: AddAdsPlan; adsetId: string; campaignName?: string; demo?: boolean }): Promise<BotAction> {
  const demo = Boolean(params.demo || !metaConfigured());
  const res: LaunchResult = demo
    ? {
        campaignId: params.plan.campaignId,
        adsetId: params.adsetId,
        creativeId: `demo_cr_${id}_1`,
        adId: `demo_ad_${id}_1`,
        creativeIds: params.plan.ads.map((_, i) => `demo_cr_${id}_${i + 1}`),
        adIds: params.plan.ads.map((_, i) => `demo_ad_${id}_${i + 1}`),
        published: params.plan.startNow,
        steps: [
          { step: "creative", ok: true, note: "simulasi mode demo" },
          { step: "ad", ok: true },
          { step: "publish", ok: true, note: `${params.plan.ads.length} iklan aktif simulasi` },
        ],
      }
    : await executeAddAds({ ...params.plan, adsetId: params.adsetId, campaignName: params.campaignName ?? params.plan.campaignName });
  const ok = res.steps.length > 0 && res.steps.every((s) => s.ok);
  const failed = res.steps.find((s) => !s.ok);
  await sql`
    UPDATE bot_actions SET status = ${ok ? "executed" : "failed"}::action_status, executed_at = ${ok ? new Date() : null},
      params = params || ${sql.json({ result: res } as any)}, meta_response = ${sql.json(res as any)},
      error = ${failed ? `Gagal di langkah ${failed.step}: ${failed.note ?? "error dari Meta"}. Iklan baru yang sempat dibuat tetap draft/jeda (tanpa biaya).` : null}
    WHERE id = ${id}`;
  log[ok ? "info" : "error"]("injeksi iklan baru", { id, ok, campaign: res.campaignId, adset: res.adsetId, count: res.adIds?.length ?? 0, published: res.published, failedStep: failed?.step, demo });
  if (res.published && metaMode() === "mcp" && !demo) void runSync("manual", accountId).catch(() => {});
  await bumpDataVersion();
  const a = await getAction(id);
  emit({ type: "action", id, status: a.status });
  return a;
}

const MEDIA_WAIT_MS = 20 * 60_000, MEDIA_POLL_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mediaPending = (e: unknown) => e instanceof HTTPException && e.status === 409 && /masih diproses/i.test(e.message);

/**
 * Owner menyuruh bot langsung menayangkan iklan: aksi dieksekusi tanpa menunggu klik konfirmasi.
 * Video yang masih diproses Meta ditunggu di latar belakang (maks. 20 menit), lalu langsung tayang.
 * Mengembalikan hasil akhir kalau selesai dalam `waitMs`; kalau belum, status terkini (kartu diperbarui lewat event).
 */
export async function executeNow(id: number, waitMs = 45_000): Promise<BotAction> {
  const run = (async () => {
    const t0 = Date.now();
    for (;;) {
      try { return await confirmAction(id); }
      catch (e) {
        if (!mediaPending(e) || Date.now() - t0 > MEDIA_WAIT_MS) {
          await sql`UPDATE bot_actions SET status = 'failed', error = ${errMsg(e)}, expires_at = NULL WHERE id = ${id} AND status = 'pending'`;
          emit({ type: "action", id, status: "failed" });
          throw e;
        }
        await sleep(MEDIA_POLL_MS);
      }
    }
  })();
  run.catch((e) => log.warn("eksekusi langsung gagal", { id, error: errMsg(e) }));
  const done = await Promise.race([run.catch(() => null), sleep(waitMs).then(() => null)]);
  return done ?? getAction(id);
}

export async function cancelAction(id: number): Promise<BotAction> {
  await sql`UPDATE bot_actions SET status = 'cancelled', expires_at = NULL WHERE id = ${id} AND status = 'pending'`;
  return getAction(id);
}

export async function revertAction(id: number): Promise<BotAction> {
  const [r] = await sql`
    UPDATE bot_actions SET status = 'reverted' WHERE id = ${id} AND status = 'executed' AND action IN ('pause','pause_ad','activate','scale','launch','add_ads')
    RETURNING account_id, campaign_id, action, params`;
  if (!r) throw new HTTPException(409, { message: "Hanya aksi yang sudah dieksekusi yang bisa dibatalkan" });
  try {
    const demo = Boolean(r.params?.demo || !metaConfigured());
    if (r.action === "launch") {
      // Membatalkan peluncuran = menjeda kampanye baru (tidak menghapus data/riwayat di Meta).
      if (!demo) await pauseLaunched(r.account_id, r.campaign_id);
      await sql`UPDATE campaigns SET status = 'PAUSED', effective_status = 'PAUSED', updated_at = now() WHERE id = ${r.campaign_id}`;
    } else if (r.action === "add_ads") {
      const adIds: string[] = r.params?.result?.adIds ?? (r.params?.result?.adId ? [r.params.result.adId] : []);
      if (adIds.length && !demo) await pauseAddedAds(r.account_id, adIds);
    } else if (r.action === "pause_ad") {
      await applyAdStatus(r.account_id, r.params, "before");
    } else await apply(r.campaign_id, r.params, "before");
  } catch (e) {
    await sql`UPDATE bot_actions SET status = 'executed', error = ${"Gagal membatalkan: " + errMsg(e)} WHERE id = ${id}`;
    throw new HTTPException(502, { message: "Gagal membatalkan di Meta: " + errMsg(e) });
  }
  await bumpDataVersion();
  return getAction(id);
}

/** Catat perubahan aturan sebagai aksi yang langsung berstatus executed (tidak mengeluarkan uang). */
export async function logRuleChange(accountId: string, field: string, value: number, previous: number | null, userId: number, source: ActionSource) {
  await sql`
    INSERT INTO bot_actions (account_id, action, params, source, status, reason, requested_by, executed_at)
    VALUES (${accountId}, 'update_rule', ${sql.json({ field, value, previous })}, ${source}::action_source, 'executed', 'Diubah owner', ${userId}, now())`;
}

export async function listActions(accountIds: string[], from: string, to: string, cursor?: string, limit = 30) {
  let cAt: string | null = null, cId = 0;
  if (cursor) [cAt, cId] = [cursor.split("_")[0], Number(cursor.split("_")[1])];
  const rows = await sql`
    ${actionSelect()}
    WHERE (b.account_id = ANY(${accountIds}) OR b.account_id IS NULL)
      AND b.created_at >= (${from}::date AT TIME ZONE 'Asia/Jakarta')
      AND b.created_at < ((${to}::date + 1) AT TIME ZONE 'Asia/Jakarta')
      AND (${cAt}::timestamptz IS NULL OR (b.created_at, b.id) < (${cAt}::timestamptz, ${cId}))
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit).map(toAction);
  const last = rows[limit - 1];
  return { actions: items, nextCursor: rows.length > limit ? `${last.created_at.toISOString()}_${last.id}` : null };
}
