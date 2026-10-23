// Uji render (Fase 0.6): bikin video iklan contoh ±20 dtk dari aset sendiri + suara sintetis, lalu catat waktu & ukuran.
// Suara di sini hanya nada pengganti dengan cap waktu per kata; suara asli datang dari ElevenLabs di fase berikutnya.
//   tsx src/sample.ts --assets ./.sample-assets --out ./.sample-out [--stills]
// Aset yang dipakai: foto-jasa.jpg dan video-jasa.mp4 di folder --assets.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { serveDir } from "./assets-server";
import { pickConcurrency, renderAd, renderFrame } from "./render";
import { estimateWords } from "./captions";
import { END_CARD_SEC, type Word } from "./schema";

const arg = (k: string, d: string) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const assets = path.resolve(arg("assets", ".sample-assets")), out = path.resolve(arg("out", ".sample-out"));
for (const f of ["foto-jasa.jpg", "video-jasa.mp4"]) if (!existsSync(path.join(assets, f))) { console.error(`Aset tidak ada: ${path.join(assets, f)}`); process.exit(1); }
mkdirSync(out, { recursive: true });

const SCRIPT = "Capek bikin video timelapse yang itu-itu aja? Sekarang kamu bisa bikin video timelapse pakai AI, cuma sepuluh menit. " +
  "Ada tutorial lengkap, plus tools yang dipakai, langkah demi langkah dari nol. Cocok buat pemula yang belum pernah edit video sama sekali. " +
  "Harganya cuma empat puluh sembilan ribu rupiah. Klik link di bawah, dan coba sekarang juga!";

/** WAV mono 16-bit: satu "suku kata" bernada per kata, supaya ada audio sungguhan di trek (tes AAC & sinkron). */
function toneWav(words: Word[], seconds: number, rate = 24000) {
  const n = Math.round(seconds * rate), pcm = Buffer.alloc(n * 2);
  words.forEach((w, wi) => {
    const f0 = 150 + (wi % 5) * 22, a = Math.round(w.start * rate), b = Math.min(n, Math.round(w.end * rate));
    for (let i = a; i < b; i++) {
      const x = (i - a) / (b - a), env = Math.sin(Math.PI * x) ** 0.6;
      const s = (Math.sin((2 * Math.PI * f0 * i) / rate) + 0.5 * Math.sin((2 * Math.PI * f0 * 2 * i) / rate)) * env * 0.35;
      pcm.writeInt16LE(Math.round(s * 32767), i * 2);
    }
  });
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const words = estimateWords(SCRIPT);
const speechEnd = words[words.length - 1].end;
const durationSec = +(speechEnd + 0.4 + END_CARD_SEC).toFixed(2);
writeFileSync(path.join(assets, "voice.wav"), toneWav(words, speechEnd + 0.4));

const srv = await serveDir(assets);
const props = {
  hook: "Bikin timelapse pakai AI",
  bullets: ["Tutorial lengkap + tools", "Cocok buat pemula"],
  priceBadge: "Rp49rb",
  cta: "Klik link di bawah",
  ctaSub: "Langsung bisa dipelajari",
  words, audioSrc: `${srv.url}/voice.wav`, durationSec,
  scenes: [
    { kind: "image" as const, src: `${srv.url}/foto-jasa.jpg`, weight: 1 },
    { kind: "video" as const, src: `${srv.url}/video-jasa.mp4`, weight: 2 },
    { kind: "image" as const, src: `${srv.url}/foto-jasa.jpg`, weight: 1 },
  ],
  brand: { name: "Contoh Brand", primary: "#1f3a8a", accent: "#facc15" },
};

console.log(`Video ${durationSec} dtk, ${words.length} kata, concurrency=${pickConcurrency(Number(process.env.RENDER_CONCURRENCY ?? 2))}`);
let last = -1;
const file = path.join(out, "contoh.mp4");
try {
  const s = await renderAd(props, file, { onProgress: (p) => { const pct = Math.floor(p * 10) * 10; if (pct !== last) { last = pct; process.stdout.write(`  ${pct}%`); } } });
  console.log(`\nSELESAI render ${(s.renderMs / 1000).toFixed(1)} dtk (bundle ${(s.bundleMs / 1000).toFixed(1)} dtk) · ${(s.bytes / 1048576).toFixed(2)} MB · ${s.frames} frame · ${(s.frames / (s.renderMs / 1000)).toFixed(1)} fps`);
  console.log(`RSS proses node: ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB (Chrome/ffmpeg dihitung terpisah)`);
  if (process.argv.includes("--stills")) {
    for (const t of [1.2, 6, 12, durationSec - 1]) await renderFrame(props, path.join(out, `frame-${t.toFixed(1)}s.png`), t);
    console.log("Frame contoh:", readdirSync(out).filter((f) => f.endsWith(".png")).join(", "));
  }
} finally {
  await srv.close();
}
