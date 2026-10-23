// Antrean render: satu job sekali jalan (RAM container ±1,4 GB per render), timeout 10 menit, file dihapus setelah 24 jam.
// Alur job: dibuat (spec) → aset diupload satu per satu → start → antre → suara → render → QC → selesai.
import { getVideoMetadata, makeCancelSignal } from "@remotion/renderer";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { serveDir } from "./assets-server";
import { renderAd, renderFrame } from "./render";
import { END_CARD_SEC, HEIGHT, WIDTH } from "./schema";
import { synthesize, type Voice } from "./voice";

const ROOT = path.resolve(process.env.JOBS_DIR || "/tmp/creative-jobs");
const TIMEOUT_MS = 10 * 60_000, KEEP_MS = 24 * 3600_000, MAX_JOBS = 30;
export const ASSET_MAX = 100 * 1024 * 1024;
export const ASSET_NAME = /^[a-z0-9_-]{1,40}\.(jpg|jpeg|png|mp4|mov)$/;
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** Durasi video total (termasuk kartu penutup) yang masuk akal untuk iklan Reels/Feed. */
export const DURATION = { min: 8, max: 45 } as const;

export const jobSpec = z.object({
  hook: z.string().trim().min(2).max(80),
  bullets: z.array(z.string().trim().min(1).max(60)).max(3).default([]),
  priceBadge: z.string().trim().max(20).optional(),
  cta: z.string().trim().min(2).max(60),
  ctaSub: z.string().trim().max(80).optional(),
  /** Naskah voice over (juga sumber subtitle). */
  script: z.string().trim().min(10).max(900),
  voiceId: z.string().max(60).optional(),
  brand: z.object({ name: z.string().trim().min(1).max(40), primary: hex, accent: hex }),
  logo: z.string().regex(ASSET_NAME).optional(),
  scenes: z.array(z.object({ asset: z.string().regex(ASSET_NAME), kind: z.enum(["image", "video"]), weight: z.number().positive().max(10).default(1) })).min(1).max(8),
});
export type JobSpec = z.infer<typeof jobSpec>;

export type JobStatus = "uploading" | "queued" | "voice" | "rendering" | "qc" | "done" | "failed";
export interface Qc { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }
export interface Job {
  id: string; status: JobStatus; progress: number; error: string | null; createdAt: number; updatedAt: number;
  spec: JobSpec; voice?: Pick<Voice, "provider" | "speechSec" | "chars">; qc?: Qc;
  result?: { bytes: number; durationSec: number; width: number; height: number; renderMs: number; memPeakMb: number | null };
}

const jobs = new Map<string, Job>();
const queue: string[] = [];
let running: string | null = null;

const dirOf = (id: string) => path.join(ROOT, id);
export const videoFile = (id: string) => path.join(dirOf(id), "out.mp4");
export const coverFile = (id: string) => path.join(dirOf(id), "cover.png");
export const assetFile = (id: string, name: string) => path.join(dirOf(id), "assets", name);

/** Saat start: sisa job proses sebelumnya tidak tercatat lagi di memori, jadi dibuang (disk VPS terbatas). */
export function initJobs() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  setInterval(() => { for (const j of [...jobs.values()]) if (Date.now() - j.updatedAt > KEEP_MS) removeJob(j.id); }, 10 * 60_000).unref();
}

export function createJob(raw: unknown): Job {
  const spec = jobSpec.parse(raw);
  if (jobs.size >= MAX_JOBS) throw Object.assign(new Error("Terlalu banyak job tersimpan, hapus yang lama dulu"), { status: 429 });
  const id = "j_" + randomBytes(9).toString("base64url");
  mkdirSync(path.join(dirOf(id), "assets"), { recursive: true });
  const job: Job = { id, status: "uploading", progress: 0, error: null, createdAt: Date.now(), updatedAt: Date.now(), spec };
  jobs.set(id, job);
  return job;
}

export const getJob = (id: string) => jobs.get(id) ?? null;
const set = (j: Job, patch: Partial<Job>) => { Object.assign(j, patch, { updatedAt: Date.now() }); };

/** Aset yang dirujuk spec tapi belum diupload. */
export function missingAssets(j: Job) {
  const need = new Set([...j.spec.scenes.map((s) => s.asset), ...(j.spec.logo ? [j.spec.logo] : [])]);
  return [...need].filter((n) => !existsSync(assetFile(j.id, n)));
}

export function startJob(j: Job) {
  if (j.status !== "uploading") throw Object.assign(new Error("Job sudah dimulai"), { status: 409 });
  const miss = missingAssets(j);
  if (miss.length) throw Object.assign(new Error(`Aset belum diupload: ${miss.join(", ")}`), { status: 409 });
  set(j, { status: "queued" });
  queue.push(j.id);
  void pump();
}

export function removeJob(id: string) {
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
  jobs.delete(id);
  if (running !== id) rmSync(dirOf(id), { recursive: true, force: true });
}

export const queueInfo = () => ({ running, queued: queue.length, jobs: jobs.size });

async function pump() {
  if (running) return;
  const id = queue.shift();
  if (!id) return;
  const j = jobs.get(id);
  if (!j) return void pump();
  running = id;
  const { cancelSignal, cancel } = makeCancelSignal();
  const timer = setTimeout(cancel, TIMEOUT_MS);
  try {
    await run(j, cancelSignal);
  } catch (e) {
    set(j, { status: "failed", error: timeoutOr(e) });
    console.error(JSON.stringify({ level: "error", msg: "job gagal", id, error: (e as Error).message }));
  } finally {
    clearTimeout(timer);
    running = null;
    if (!jobs.has(id)) rmSync(dirOf(id), { recursive: true, force: true }); // dihapus saat masih berjalan
    void pump();
  }
}
const timeoutOr = (e: unknown) => (/cancel/i.test((e as Error).message) ? "Render melewati batas 10 menit" : (e as Error).message);

/** Video sumber 4K membuat pembaca video Remotion memakan RAM jauh di atas batas container. */
async function checkSources(j: Job) {
  for (const s of j.spec.scenes.filter((x) => x.kind === "video")) {
    const m = await getVideoMetadata(assetFile(j.id, s.asset)).catch(() => null);
    if (!m) throw new Error(`Video ${s.asset} tidak bisa dibaca (rusak atau format tidak didukung)`);
    if (m.width * m.height > 1920 * 1088) throw new Error(`Video ${s.asset} beresolusi ${m.width}×${m.height}. Kirim versi maksimal 1080p.`);
  }
}

async function run(j: Job, cancelSignal: ReturnType<typeof makeCancelSignal>["cancelSignal"]) {
  const dir = dirOf(j.id);
  await checkSources(j);
  set(j, { status: "voice", progress: 0 });
  const voice = await synthesize(j.spec.script, dir, { voiceId: j.spec.voiceId });
  const durationSec = +(voice.speechSec + 0.4 + END_CARD_SEC).toFixed(2);
  if (durationSec > DURATION.max) throw new Error(`Naskah terlalu panjang: video jadi ${durationSec.toFixed(0)} dtk (maks. ${DURATION.max}). Persingkat naskahnya.`);
  set(j, { voice: { provider: voice.provider, speechSec: voice.speechSec, chars: voice.chars }, status: "rendering" });

  const srv = await serveDir(dir);
  const s = j.spec;
  const props = {
    hook: s.hook, bullets: s.bullets, priceBadge: s.priceBadge, cta: s.cta, ctaSub: s.ctaSub, brand: s.brand,
    words: voice.words, durationSec: Math.max(durationSec, DURATION.min),
    audioSrc: voice.file ? `${srv.url}/${path.basename(voice.file)}` : undefined,
    logoSrc: s.logo ? `${srv.url}/assets/${s.logo}` : undefined,
    scenes: s.scenes.map((x) => ({ kind: x.kind, src: `${srv.url}/assets/${x.asset}`, weight: x.weight })),
  };
  try {
    const r = await renderAd(props, videoFile(j.id), { cancelSignal, onProgress: (p) => set(j, { progress: Math.round(p * 100) }) });
    set(j, { status: "qc", progress: 100 });
    // Cover = frame setelah hook muncul, resolusi penuh (thumbnail buatan Meta hanya 160 px).
    await renderFrame(props, coverFile(j.id), Math.min(1.4, props.durationSec / 3), cancelSignal);
    const qc = await runQc(j, props.durationSec, Boolean(voice.file));
    const meta = await getVideoMetadata(videoFile(j.id));
    set(j, {
      qc, status: qc.ok ? "done" : "failed", error: qc.ok ? null : "QC gagal: " + qc.checks.filter((c) => !c.ok).map((c) => c.detail).join("; "),
      result: { bytes: r.bytes, durationSec: meta.durationInSeconds ?? r.durationSec, width: meta.width, height: meta.height, renderMs: r.renderMs, memPeakMb: memPeakMb() },
    });
    console.log(JSON.stringify({ level: "info", msg: "job selesai", id: j.id, qc: qc.ok, renderMs: r.renderMs, memPeakMb: memPeakMb(), voice: voice.provider }));
  } finally {
    await srv.close();
  }
}

/** Gerbang QC teknis (PLAN §4.4). Isi naskah & harga sudah divalidasi dashboard sebelum job dibuat. */
export async function runQc(j: Job, expectedSec: number, hasVoice: boolean): Promise<Qc> {
  const file = videoFile(j.id);
  const m = await getVideoMetadata(file);
  const scale = (() => { const [a, b = 1] = (process.env.RENDER_SCALE ?? "1").split("/").map(Number); return a / b || 1; })();
  const w = Math.round(WIDTH * scale), h = Math.round(HEIGHT * scale);
  const size = statSync(file).size;
  const checks = [
    { name: "codec", ok: m.codec === "h264", detail: `codec ${m.codec}` },
    { name: "ukuran", ok: m.width === w && m.height === h, detail: `${m.width}×${m.height} (harus ${w}×${h}, 9:16)` },
    { name: "durasi", ok: m.durationInSeconds != null && Math.abs(m.durationInSeconds - expectedSec) < 0.6 && m.durationInSeconds >= DURATION.min - 0.5 && m.durationInSeconds <= DURATION.max + 0.5,
      detail: `durasi ${m.durationInSeconds?.toFixed(1)} dtk (harapan ${expectedSec.toFixed(1)})` },
    { name: "audio", ok: hasVoice ? m.audioCodec === "aac" : true, detail: hasVoice ? `audio ${m.audioCodec ?? "tidak ada"}` : "tanpa suara (subtitle saja)" },
    { name: "file", ok: size > 50_000 && size < ASSET_MAX, detail: `${(size / 1048576).toFixed(1)} MB` },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

/** Puncak RAM container (cgroup v2), untuk memantau sisa ruang terhadap batas 2 GB. */
function memPeakMb() {
  try { return Math.round(Number(readFileSync("/sys/fs/cgroup/memory.peak", "utf8")) / 1048576); } catch { return null; }
}

/** Untuk tes. */
export const _jobsDir = () => ROOT;
export const _listDir = (id: string) => (existsSync(dirOf(id)) ? readdirSync(dirOf(id)) : []);
