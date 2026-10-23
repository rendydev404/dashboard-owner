// Render MP4 iklan dari props. Bundle Remotion dibuat sekali per proses (±10 detik), render berikutnya memakai ulang.
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition, type CancelSignal } from "@remotion/renderer";
import { existsSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adProps } from "./schema";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "remotion-entry.ts");
let bundled: Promise<string> | null = null;
// Di produksi bundle dibuat saat build image (BUNDLE_DIR): bundling webpack memakan >1 GB RAM, tidak boleh terjadi saat runtime.
const PREBUILT = process.env.BUNDLE_DIR && existsSync(path.join(process.env.BUNDLE_DIR, "index.html")) ? path.resolve(process.env.BUNDLE_DIR) : null;
const getBundle = () => (PREBUILT ? Promise.resolve(PREBUILT) : (bundled ??= bundle({ entryPoint: ENTRY })));

/** Remotion menolak concurrency di atas jumlah core yang terlihat (container --cpus=1.5 terbaca 1 core). */
export const pickConcurrency = (want: number, cores = availableParallelism()) => Math.max(1, Math.min(Math.floor(want) || 1, cores));

/** Port bebas acak untuk server internal Remotion (bawaannya 3000, yang bisa bentrok dengan aplikasi lain di mesin yang sama). */
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

export interface RenderOpts { concurrency?: number; onProgress?: (p: number) => void; cancelSignal?: CancelSignal }
export interface RenderStats { renderMs: number; bundleMs: number; bytes: number; frames: number; durationSec: number }

// Di container tanpa GPU render memakai software GL (RENDER_GL=swangle); di laptop biarkan bawaan Remotion.
// Cache pembaca video Remotion bawaannya ±50% RAM yang TERLIHAT (RAM server, bukan batas container) → container ikut mati (OOM).
const videoCache = Number(process.env.VIDEO_CACHE_MB ?? 100) * 1048576;
const chromium = process.env.RENDER_GL ? { gl: process.env.RENDER_GL as "swangle" | "angle" | "egl" | "vulkan" } : {};
// RENDER_SCALE=2/3 → 720×1280 (Meta menerima ≥ 600 px lebar): piksel ±56% lebih sedikit bila RAM/CPU server sempit.
// Ditulis sebagai pecahan: Remotion menolak ukuran tidak bulat (0.667 × 1920 = 1279,97).
const [sa, sb = 1] = (process.env.RENDER_SCALE ?? "1").split("/").map(Number);
const scale = sa / sb || 1;

export async function renderAd(raw: unknown, outFile: string, opts: RenderOpts = {}): Promise<RenderStats> {
  const props = adProps.parse(raw);
  const b0 = Date.now();
  const serveUrl = await getBundle();
  const bundleMs = Date.now() - b0;
  const port = await freePort();
  const composition = await selectComposition({ serveUrl, id: "Ad", inputProps: props, chromiumOptions: chromium, port });
  const t0 = Date.now();
  await renderMedia({
    composition, serveUrl, inputProps: props, outputLocation: outFile, port, scale,
    codec: "h264", pixelFormat: "yuv420p", crf: 23, x264Preset: "veryfast", audioCodec: "aac", enforceAudioTrack: Boolean(props.audioSrc),
    concurrency: pickConcurrency(opts.concurrency ?? Number(process.env.RENDER_CONCURRENCY ?? 2)),
    chromiumOptions: chromium, timeoutInMilliseconds: 120_000, offthreadVideoCacheSizeInBytes: videoCache,
    onProgress: ({ progress }) => opts.onProgress?.(progress), cancelSignal: opts.cancelSignal,
  });
  return { renderMs: Date.now() - t0, bundleMs, bytes: statSync(outFile).size, frames: composition.durationInFrames, durationSec: composition.durationInFrames / composition.fps };
}

/** Satu frame PNG pada detik tertentu, untuk pratinjau & QC visual. */
export async function renderFrame(raw: unknown, outPng: string, atSec: number, cancelSignal?: CancelSignal) {
  const props = adProps.parse(raw);
  const serveUrl = await getBundle();
  const port = await freePort();
  const composition = await selectComposition({ serveUrl, id: "Ad", inputProps: props, chromiumOptions: chromium, port });
  await renderStill({ composition, serveUrl, inputProps: props, output: outPng, port, offthreadVideoCacheSizeInBytes: videoCache, frame: Math.min(composition.durationInFrames - 1, Math.round(atSec * composition.fps)), chromiumOptions: chromium, scale, cancelSignal });
}
