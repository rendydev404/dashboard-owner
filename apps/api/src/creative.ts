// Video iklan buatan bot (PLAN konten otomatis): naskah dari Claude → worker render (suara + subtitle + template) → QC
// → kartu pratinjau di chat → owner MENYETUJUI → upload ke Meta → kampanye dibuat & tayang lewat alur launch yang sudah ada.
// Tidak ada yang menyentuh Meta sebelum owner menekan "Setujui & iklankan". File video hanya di disk sementara (media.ts).
import { Readable } from "node:stream";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { CreativeRun } from "@iklan/shared";
import { creativeConfigured, env, metaMode } from "./env";
import { sql } from "./db";
import { loadConfig } from "./scope";
import { getMedia, readMedia, removeMedia, saveMedia } from "./media";
import { LAUNCH_CTAS, LAUNCH_OBJECTIVES, launchPlanSchema, validateLaunchPlan, type LaunchPlan } from "./meta/launch";
import { uploadAttachment } from "./meta/upload";
import { confirmAction, createLaunchAction } from "./actions";
import { errMsg, log } from "./log";

const WEEKLY_MAX = 5; // PLAN §4.5: maks. 5 iklan baru/minggu per akun dari sistem ini
const VIDEO_TTL_MS = 24 * 3600_000; // PLAN §4.6: file yang tidak jadi dipakai dihapus maks. 24 jam
const POLL_MS = 3000, RENDER_MAX_MS = 15 * 60_000, META_POLL_MS = 10_000, META_MAX_MS = 20 * 60_000;
const BRAND = { primary: "#1f2a5a", accent: "#facc15" };

export const videoAdInput = z.object({
  accountId: z.string().regex(/^\d{5,25}$/),
  hook: z.string().trim().min(2).max(80),
  bullets: z.array(z.string().trim().min(1).max(60)).max(3).default([]),
  priceBadge: z.string().trim().max(20).optional(),
  cta: z.string().trim().min(2).max(60),
  ctaSub: z.string().trim().max(80).optional(),
  script: z.string().trim().min(40).max(900),
  mediaIds: z.array(z.string()).min(1).max(6),
  logoMediaId: z.string().optional(),
  brandName: z.string().trim().min(1).max(40).optional(),
  campaign: z.object({
    campaignName: z.string(), objective: z.enum(LAUNCH_OBJECTIVES), dailyBudget: z.number().int().positive(),
    pageId: z.string(), instagramUserId: z.string().optional(), pixelId: z.string().optional(), linkUrl: z.string().optional(),
    targeting: z.unknown().optional(), primaryText: z.string(), headline: z.string(), description: z.string().optional(),
    metaCta: z.enum(LAUNCH_CTAS).default("LEARN_MORE"), adName: z.string(), startNow: z.boolean().default(true), rationale: z.string().optional(),
  }),
});
type VideoAdInput = z.infer<typeof videoAdInput>;

/* ------------------------------------------------------------------ worker */

/** Panggil worker; kegagalan jaringan sesaat (render memakan CPU) diulang beberapa kali. */
async function wk(path: string, init: RequestInit = {}, retry = 3): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(new URL(path, env.CREATIVE_WORKER_URL), {
        ...init, headers: { Authorization: `Bearer ${env.CREATIVE_WORKER_TOKEN}`, ...init.headers }, signal: AbortSignal.timeout(120_000),
      });
      if (res.status >= 500 && i < retry && !init.body) { await sleep(1000); continue; }
      return res;
    } catch (e) {
      if (i >= retry || init.body instanceof ReadableStream) throw new Error("Worker video tidak bisa dihubungi: " + errMsg(e));
      await sleep(1000);
    }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function wkJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await wk(path, init);
  const body = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Worker menolak (HTTP ${res.status})`);
  return body;
}

/* ------------------------------------------------------------------ validasi */

/** "Rp49rb", "Rp 49.000", "49k", "Rp1,2jt" → rupiah. null kalau tidak ada angka. */
export function parsePrice(s: string): number | null {
  const m = /(\d+(?:[.,]\d+)*)\s*(rb|ribu|k|jt|juta)?/i.exec(s.replace(/\s+/g, " "));
  if (!m) return null;
  const unit = (m[2] ?? "").toLowerCase();
  // Dengan satuan, koma/titik = desimal ("1,2jt"); tanpa satuan = pemisah ribuan ("49.000").
  const n = unit ? Number(m[1].replace(",", ".")) : Number(m[1].replace(/[.,]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (unit === "jt" || unit === "juta" ? 1e6 : unit ? 1e3 : 1));
}

function planOf(input: VideoAdInput): LaunchPlan {
  const c = input.campaign;
  const parsed = launchPlanSchema.safeParse({
    accountId: input.accountId, campaignName: c.campaignName, objective: c.objective, dailyBudget: c.dailyBudget, pageId: c.pageId,
    instagramUserId: c.instagramUserId, pixelId: c.pixelId, linkUrl: c.linkUrl, targeting: c.targeting, adName: c.adName,
    startNow: c.startNow, rationale: c.rationale,
    // videoId sementara; diganti ID asli setelah video diupload ke Meta saat owner menyetujui.
    creative: { type: "new", videoId: "0", primaryText: c.primaryText, headline: c.headline, description: c.description, cta: c.metaCta },
  });
  if (!parsed.success) throw new Error("Rencana kampanye belum lengkap/valid: " + JSON.stringify(parsed.error.flatten().fieldErrors));
  return parsed.data;
}

/** Usulan video dari bot → run baru (status queued) + proses render di latar belakang. */
export async function createVideoAd(raw: unknown, userId: number): Promise<{ runId: number }> {
  if (!creativeConfigured()) throw new Error("Worker video belum dipasang di server (CREATIVE_WORKER_URL). Bilang ke user fitur video belum aktif.");
  const input = videoAdInput.parse(raw);
  const cfg = await loadConfig();
  const acc = cfg.accounts.find((a) => a.id === input.accountId && a.active);
  if (!acc) throw new Error("Akun iklan tidak terdaftar atau tidak aktif. Tanyakan akun mana (list_ad_accounts).");

  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM creative_runs
    WHERE account_id = ${acc.id} AND created_at > now() - interval '7 days' AND status NOT IN ('failed','discarded','expired')`;
  if (n >= WEEKLY_MAX) throw new Error(`Batas ${WEEKLY_MAX} video iklan baru per minggu untuk akun ini sudah tercapai (melindungi akun iklan). Coba lagi minggu depan.`);

  let plan = planOf(input);
  // Dengan Meta terhubung, rencana divalidasi penuh sekarang (budget min/maks, pixel, link) supaya owner tidak
  // menyetujui video yang ternyata tidak bisa diluncurkan.
  if (metaMode() === "mcp") plan = (await validateLaunchPlan(plan)).plan;

  // Harga di video wajib persis data produk dashboard (PLAN §4.3), bukan karangan model.
  if (input.priceBadge) {
    const price = parsePrice(input.priceBadge);
    const products = await sql`SELECT name, price FROM products WHERE active AND line = ${acc.line} AND price IS NOT NULL`;
    if (price == null || !products.some((p) => Number(p.price) === price)) {
      throw new Error(`Harga "${input.priceBadge}" tidak cocok dengan data produk. Harga yang ada: ${products.map((p) => `${p.name} = Rp${Number(p.price).toLocaleString("id-ID")}`).join(", ") || "(belum ada harga produk)"}. Pakai salah satunya atau kosongkan priceBadge.`);
    }
  }
  for (const id of [...input.mediaIds, ...(input.logoMediaId ? [input.logoMediaId] : [])]) {
    const e = getMedia(id, userId);
    if (!e?.file) throw new Error(`Lampiran ${id} tidak ditemukan atau sudah dipakai/kedaluwarsa. Minta user upload ulang foto/videonya.`);
    if (id === input.logoMediaId && e.kind !== "image") throw new Error("Logo harus berupa foto PNG/JPG");
  }

  const brief = {
    hook: input.hook, bullets: input.bullets, priceBadge: input.priceBadge, cta: input.cta, ctaSub: input.ctaSub, script: input.script,
    mediaIds: input.mediaIds, logoMediaId: input.logoMediaId, brandName: input.brandName ?? acc.name,
  };
  const [row] = await sql`
    INSERT INTO creative_runs (user_id, account_id, brief, plan, note)
    VALUES (${userId}, ${acc.id}, ${sql.json(brief)}, ${sql.json(plan as any)}, 'Mengantre di worker')
    RETURNING id`;
  const runId = Number(row.id);
  void render(runId, userId).catch((e) => fail(runId, errMsg(e)));
  log.info("video iklan diminta", { runId, account: acc.id });
  return { runId };
}

/* ------------------------------------------------------------------ render */

const update = (id: number, f: Record<string, unknown>) => {
  const row = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v && typeof v === "object" ? sql.json(v as any) : v]));
  return sql`UPDATE creative_runs SET ${sql(row as any)}, updated_at = now() WHERE id = ${id}`;
};
async function fail(id: number, error: string) {
  await update(id, { status: "failed", error: error.slice(0, 800), note: null });
  log.error("video iklan gagal", { runId: id, error });
}

const ext = (mime: string) => ({ "image/jpeg": "jpg", "image/png": "png", "video/mp4": "mp4", "video/quicktime": "mov" })[mime] ?? "bin";
const STAGE: Record<string, string> = { queued: "Mengantre di worker", voice: "Membuat suara narasi", rendering: "Merender video", qc: "Memeriksa kualitas" };

async function render(runId: number, userId: number) {
  const [run] = await sql`SELECT brief FROM creative_runs WHERE id = ${runId}`;
  const b = run.brief;
  const files = (b.mediaIds as string[]).map((id, i) => {
    const m = readMedia(id, userId);
    if (!m) throw new Error("Lampiran sudah tidak ada. Minta user upload ulang.");
    return { m, asset: `s${i + 1}.${ext(m.entry.mime)}` };
  });
  const logo = b.logoMediaId ? readMedia(b.logoMediaId, userId) : null;
  const job = await wkJson<{ id: string }>("/jobs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hook: b.hook, bullets: b.bullets, priceBadge: b.priceBadge, cta: b.cta, ctaSub: b.ctaSub, script: b.script,
      brand: { name: b.brandName, ...BRAND }, logo: logo ? `logo.${ext(logo.entry.mime)}` : undefined,
      scenes: files.map((f) => ({ asset: f.asset, kind: f.m.entry.kind, weight: f.m.entry.kind === "video" ? 2 : 1 })),
    }),
  });
  await update(runId, { worker_job: job.id, status: "rendering" });
  const put = async (name: string, m: NonNullable<ReturnType<typeof readMedia>>) => {
    await wkJson(`/jobs/${job.id}/assets/${name}`, {
      method: "PUT", body: Readable.toWeb(m.stream()) as ReadableStream, duplex: "half",
    } as RequestInit);
  };
  for (const f of files) await put(f.asset, f.m);
  if (logo) await put(`logo.${ext(logo.entry.mime)}`, logo);
  await wkJson(`/jobs/${job.id}/start`, { method: "POST" });

  const started = Date.now();
  let last = "";
  for (;;) {
    await sleep(POLL_MS);
    const j = await wkJson<{ status: string; progress: number; error: string | null; voice?: unknown; qc?: unknown; result?: unknown }>(`/jobs/${job.id}`);
    const key = `${j.status}:${j.progress}`;
    if (key !== last) { last = key; await update(runId, { progress: j.progress, note: STAGE[j.status] ?? null }); }
    if (j.status === "failed") { await update(runId, { voice: j.voice ?? null, qc: j.qc ?? null }); throw new Error(j.error ?? "Render gagal"); }
    if (j.status === "done") {
      const media = await saveMedia((await wk(`/jobs/${job.id}/video`)).body, { name: `video-iklan-${runId}.mp4`, userId, ttlMs: VIDEO_TTL_MS });
      // Cover resolusi penuh jadi thumbnail iklan video (uploadAttachment memakainya otomatis).
      const cover = await wk(`/jobs/${job.id}/cover`);
      if (cover.ok) await saveMedia(cover.body, { name: `cover-${runId}.png`, userId, coverFor: media.id, ttlMs: VIDEO_TTL_MS }).catch(() => null);
      await update(runId, { status: "review", media_id: media.id, voice: j.voice ?? null, qc: j.qc ?? null, result: j.result ?? null, progress: 100, note: null });
      void wk(`/jobs/${job.id}`, { method: "DELETE" }).catch(() => {});
      log.info("video iklan siap direview", { runId, media: media.id });
      return;
    }
    if (Date.now() - started > RENDER_MAX_MS) throw new Error("Render tidak selesai dalam 15 menit");
  }
}

/* ------------------------------------------------------------------ persetujuan → Meta */

/** Owner menyetujui: video diupload ke Meta, ditunggu sampai siap, lalu kampanye dibuat & (sesuai rencana) langsung tayang. */
export async function approveRun(id: number): Promise<CreativeRun> {
  // Dicek sebelum diklaim: video tetap menunggu review dan bisa disetujui lagi setelah Meta tersambung.
  if (metaMode() !== "mcp") throw new HTTPException(409, { message: "Meta belum terhubung lewat MCP, jadi video belum bisa diiklankan. Video tetap tersimpan 24 jam; setujui lagi setelah Meta tersambung." });
  const [r] = await sql`UPDATE creative_runs SET status = 'approved', approved_at = now(), updated_at = now(), note = 'Disetujui owner'
                        WHERE id = ${id} AND status = 'review' RETURNING user_id, media_id`;
  if (!r) {
    const cur = await getRun(id);
    throw new HTTPException(409, { message: cur.status === "expired" ? "Video sudah kedaluwarsa, minta bot membuat ulang" : "Video ini sudah diproses" });
  }
  if (!getMedia(r.media_id, Number(r.user_id))) {
    await update(id, { status: "expired", note: null, error: "File video sudah terhapus (lebih dari 24 jam atau server dimulai ulang)" });
    return getRun(id);
  }
  void launch(id).catch((e) => fail(id, errMsg(e)));
  return getRun(id);
}

async function launch(id: number) {
  const [run] = await sql`SELECT user_id, account_id, media_id, plan FROM creative_runs WHERE id = ${id}`;
  const userId = Number(run.user_id);
  await update(id, { status: "uploading", note: "Mengupload video ke Meta" });
  let up = await uploadAttachment(run.media_id, userId, run.account_id);
  const t0 = Date.now();
  while (up.status === "processing") {
    if (Date.now() - t0 > META_MAX_MS) throw new Error("Meta belum selesai memproses video dalam 20 menit. Cek perpustakaan media di Ads Manager.");
    await update(id, { note: up.note.replace(/\.\s.*$/, "") || "Meta memproses video" });
    await sleep(META_POLL_MS);
    up = await uploadAttachment(run.media_id, userId, run.account_id);
  }
  if (up.status === "error" || !up.videoId) throw new Error(up.error ?? "Meta gagal memproses video");

  const plan: LaunchPlan = { ...run.plan, creative: { ...run.plan.creative, videoId: up.videoId, ...(up.thumbnailHash ? { imageHash: up.thumbnailHash } : {}) } };
  await update(id, { status: "launching", note: plan.startNow ? "Membuat kampanye & menayangkan" : "Membuat kampanye sebagai draft" });
  // Persetujuan owner di kartu video = konfirmasi peluncuran, jadi aksi langsung dijalankan.
  const action = await createLaunchAction(plan, userId, plan.rationale);
  await update(id, { action_id: action.id });
  const done = await confirmAction(action.id);
  if (done.status === "executed") await update(id, { status: "launched", note: null, error: null });
  else await fail(id, done.error ?? "Peluncuran gagal");
}

export async function discardRun(id: number): Promise<CreativeRun> {
  const [r] = await sql`UPDATE creative_runs SET status = 'discarded', note = null, updated_at = now()
                        WHERE id = ${id} AND status IN ('queued','rendering','review','failed') RETURNING user_id, media_id, worker_job`;
  if (!r) throw new HTTPException(409, { message: "Video ini sudah diproses, tidak bisa dibuang" });
  if (r.media_id) await removeMedia(r.media_id, Number(r.user_id)).catch(() => {});
  if (r.worker_job) void wk(`/jobs/${r.worker_job}`, { method: "DELETE" }).catch(() => {});
  return getRun(id);
}

/* ------------------------------------------------------------------ baca */

export async function getRun(id: number): Promise<CreativeRun> {
  const [r] = await sql`
    SELECT r.id, r.status, r.progress, r.note, r.error, r.account_id, a.display_name AS account_name, r.brief, r.plan, r.voice, r.qc,
           r.result, r.media_id, r.user_id, r.created_at, b.id AS action_id, b.status AS action_status, b.campaign_id, b.error AS action_error
    FROM creative_runs r JOIN ad_accounts a ON a.id = r.account_id LEFT JOIN bot_actions b ON b.id = r.action_id
    WHERE r.id = ${id}`;
  if (!r) throw new HTTPException(404, { message: "Video tidak ditemukan" });
  const p = r.plan, c = p.creative ?? {};
  return {
    id: Number(r.id), status: r.status, progress: r.progress, note: r.note, error: r.error, accountId: r.account_id, accountName: r.account_name,
    brief: { hook: r.brief.hook, bullets: r.brief.bullets ?? [], priceBadge: r.brief.priceBadge, cta: r.brief.cta, script: r.brief.script },
    plan: { campaignName: p.campaignName, objective: p.objective, dailyBudget: p.dailyBudget, startNow: p.startNow, primaryText: c.primaryText, headline: c.headline, cta: c.cta, linkUrl: p.linkUrl },
    voice: r.voice ? { provider: r.voice.provider, speechSec: r.voice.speechSec } : null,
    qc: r.qc ?? null,
    result: r.result ? { bytes: r.result.bytes, durationSec: r.result.durationSec, width: r.result.width, height: r.result.height } : null,
    action: r.action_id ? { id: Number(r.action_id), status: r.action_status, campaignId: r.campaign_id, error: r.action_error } : null,
    hasVideo: Boolean(r.media_id && getMedia(r.media_id, Number(r.user_id))?.file),
    createdAt: r.created_at.toISOString(),
  };
}

/** File MP4 untuk diputar di kartu pratinjau. */
export async function runVideo(id: number) {
  const [r] = await sql`SELECT user_id, media_id FROM creative_runs WHERE id = ${id}`;
  return r?.media_id ? readMedia(r.media_id, Number(r.user_id)) : null;
}

/** Cover PNG (poster pemutar, supaya frame pertama tidak hitam saat adegan masih fade-in). */
export async function runCover(id: number) {
  const [r] = await sql`SELECT user_id, media_id FROM creative_runs WHERE id = ${id}`;
  const cover = r?.media_id ? getMedia(r.media_id, Number(r.user_id))?.coverId : null;
  return cover ? readMedia(cover, Number(r.user_id)) : null;
}

/**
 * Saat server start: proses latar belakang yang terputus tidak bisa dilanjutkan, dan file sementara (di memori proses)
 * sudah hilang, jadi run yang belum selesai ditandai supaya kartu tidak menunggu selamanya.
 */
export async function recoverCreativeRuns() {
  await sql`UPDATE creative_runs SET status = 'failed', note = null, updated_at = now(),
              error = 'Server dimulai ulang saat proses berjalan. ' || CASE WHEN status IN ('approved','uploading','launching')
                THEN 'Cek Ads Manager: kampanye mungkin sudah dibuat sebagai draft.' ELSE 'Minta bot membuat ulang videonya.' END
            WHERE status IN ('queued','rendering','approved','uploading','launching')`;
  await sql`UPDATE creative_runs SET status = 'expired', note = null, updated_at = now() WHERE status = 'review'`;
}
