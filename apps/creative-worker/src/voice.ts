// Suara narasi + cap waktu per kata untuk subtitle.
// Prioritas:
// 1. ElevenLabs REST "with-timestamps" jika ELEVENLABS_API_KEY diisi.
// 2. Tahap 1 Gratis (Rp0): Google/Edge Indonesian TTS per klausa (64kbps CBR MP3) + sinkronisasi waktu kata per klausa.
// 3. Fallback offline: video tanpa suara dengan subtitle berwaktu perkiraan.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { estimateWords, normalizeWords, wordsFromAlignment } from "./captions";
import type { Word } from "./schema";

export interface Voice {
  provider: "elevenlabs" | "free-id" | "none";
  file: string | null;
  words: Word[];
  speechSec: number;
  chars: number;
}

const API = "https://api.elevenlabs.io/v1";
const FREE_TTS_URL = "https://translate.google.com/translate_tts";
// MPEG-2 Layer III 64 kbps mono = 8.000 byte per detik
const CBR_BYTES_PER_SEC = 8000;

export const voiceProvider = (): Voice["provider"] =>
  process.env.ELEVENLABS_API_KEY
    ? "elevenlabs"
    : process.env.VOICE_PROVIDER === "none"
      ? "none"
      : "free-id";

/** Pecah naskah menjadi klausa pendek (<= 160 karakter) agar tiap klausa punya durasi audio presisi. */
export function splitClauses(text: string, maxLen = 160): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);

  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxLen) {
      out.push(s);
      continue;
    }
    const parts = s.split(/(?<=[,;:])\s+/).filter(Boolean);
    let cur = "";
    for (const p of parts) {
      const next = cur ? `${cur} ${p}` : p;
      if (next.length <= maxLen) {
        cur = next;
      } else {
        if (cur) out.push(cur);
        if (p.length <= maxLen) {
          cur = p;
        } else {
          // Pecah per kata jika satu anak kalimat masih > maxLen
          const words = p.split(" ");
          let wAcc = "";
          for (const w of words) {
            const wNext = wAcc ? `${wAcc} ${w}` : w;
            if (wNext.length <= maxLen) wAcc = wNext;
            else {
              if (wAcc) out.push(wAcc);
              wAcc = w;
            }
          }
          cur = wAcc;
        }
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Tahap 1 Gratis (Rp0): Sintesis suara Bahasa Indonesia per klausa + penyelarasan cap waktu kata. */
async function synthesizeFreeIndonesian(text: string, dir: string, signal?: AbortSignal): Promise<Voice> {
  const clauses = splitClauses(text);
  const buffers: Buffer[] = [];
  const words: Word[] = [];
  let cursor = 0;

  for (const clause of clauses) {
    const u = new URL(FREE_TTS_URL);
    u.searchParams.set("ie", "UTF-8");
    u.searchParams.set("q", clause);
    u.searchParams.set("tl", "id");
    u.searchParams.set("client", "tw-ob");
    u.searchParams.set("ttsspeed", "1");

    const res = await fetch(u, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
      },
      signal: signal ?? AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`TTS gratis gagal (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 512) throw new Error("Audio TTS gratis kosong");
    buffers.push(buf);

    const chunkSec = Math.max(0.45, buf.length / CBR_BYTES_PER_SEC);
    const tokens = clause.trim().split(/\s+/).filter(Boolean);
    const leadPad = Math.min(0.08, chunkSec * 0.06);
    const tailPad = Math.min(0.14, chunkSec * 0.1);
    const usableSec = Math.max(0.2, chunkSec - leadPad - tailPad);

    const weights = tokens.map((tok) => {
      const letters = tok.replace(/[^\p{L}\p{N}]/gu, "").length;
      const punctBonus = /[.!?]$/.test(tok) ? 2.2 : /[,;:]$/.test(tok) ? 1.2 : 0;
      return Math.max(2, letters) + punctBonus;
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;

    let t = cursor + leadPad;
    tokens.forEach((tok, idx) => {
      const share = (weights[idx] / totalWeight) * usableSec;
      const pause = /[.!?]$/.test(tok) ? Math.min(0.08, share * 0.2) : /[,;:]$/.test(tok) ? Math.min(0.05, share * 0.15) : 0.015;
      const dur = Math.max(0.09, share - pause);
      words.push({
        text: tok,
        start: +t.toFixed(3),
        end: +(t + dur).toFixed(3),
      });
      t += share;
    });

    cursor += chunkSec;
  }

  const file = path.join(dir, "voice.mp3");
  await writeFile(file, Buffer.concat(buffers));
  const normalized = normalizeWords(words);
  return {
    provider: "free-id",
    file,
    words: normalized,
    speechSec: +Math.max(cursor, normalized.at(-1)?.end ?? 1).toFixed(2),
    chars: text.length,
  };
}

export async function synthesize(text: string, dir: string, opts: { voiceId?: string; signal?: AbortSignal } = {}): Promise<Voice> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    if (process.env.VOICE_PROVIDER !== "none") {
      try {
        return await synthesizeFreeIndonesian(text, dir, opts.signal);
      } catch {
        // Fallback aman jika mesin sedang tanpa internet (mis. unit test terisolasi)
      }
    }
    const words = estimateWords(text);
    return { provider: "none", file: null, words, speechSec: words.at(-1)!.end, chars: 0 };
  }
  // Default ke suara premade ElevenLabs ("JBFqnCBsd6RMkjVDRZzb" = George / "nPczCjzI2devNBz1zQrb" = Brian)
  // yang diizinkan pada paket GRATIS (Free Tier) tanpa perlu mencari Voice ID manual.
  const voiceId = opts.voiceId || process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
  const modelId = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
  const isFlashOrTurbo = /flash|turbo/i.test(modelId);
  const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: modelId,
      ...(isFlashOrTurbo ? { language_code: "id" } : {}),
      voice_settings: { stability: 0.42, similarity_boost: 0.82, style: 0.3, use_speaker_boost: true },
    }),
    signal: opts.signal ?? AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (res.status === 401) throw new Error("API key ElevenLabs ditolak (401). Cek ELEVENLABS_API_KEY.");
    if (res.status === 402) throw new Error("Paket gratis ElevenLabs tidak bisa memakai suara Voice Library lewat API. Pakai suara bawaan (premade) atau upgrade paket.");
    if (res.status === 429 || /quota/i.test(body)) throw new Error("Kuota ElevenLabs habis atau terlalu banyak permintaan. Coba lagi nanti.");
    throw new Error(`ElevenLabs gagal (HTTP ${res.status}): ${body}`);
  }
  const j = (await res.json()) as {
    audio_base64: string;
    alignment?: Parameters<typeof wordsFromAlignment>[0];
    normalized_alignment?: Parameters<typeof wordsFromAlignment>[0];
  };
  const align = j.alignment ?? j.normalized_alignment;
  if (!j.audio_base64 || !align?.characters?.length) throw new Error("ElevenLabs tidak mengembalikan audio + cap waktu");
  const file = path.join(dir, "voice.mp3");
  await writeFile(file, Buffer.from(j.audio_base64, "base64"));
  const words = normalizeWords(wordsFromAlignment(align));
  if (!words.length) throw new Error("Cap waktu ElevenLabs kosong");
  return { provider: "elevenlabs", file, words, speechSec: words.at(-1)!.end, chars: text.length };
}
