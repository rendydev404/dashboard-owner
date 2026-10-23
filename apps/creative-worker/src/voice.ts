// Suara narasi + cap waktu per kata untuk subtitle.
// ElevenLabs REST "with-timestamps" (API key, paket gratis pun bisa) memberi audio + waktu per karakter sekaligus.
// Tanpa API key: video tanpa suara dengan subtitle berwaktu perkiraan, supaya alur tetap bisa dipakai & diuji.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { estimateWords, normalizeWords, wordsFromAlignment } from "./captions";
import type { Word } from "./schema";

export interface Voice { provider: "elevenlabs" | "none"; file: string | null; words: Word[]; speechSec: number; chars: number }

const API = "https://api.elevenlabs.io/v1";

export const voiceProvider = () => (process.env.ELEVENLABS_API_KEY ? "elevenlabs" : "none") as Voice["provider"];

export async function synthesize(text: string, dir: string, opts: { voiceId?: string; signal?: AbortSignal } = {}): Promise<Voice> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    const words = estimateWords(text);
    return { provider: "none", file: null, words, speechSec: words.at(-1)!.end, chars: 0 };
  }
  const voiceId = opts.voiceId || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) throw new Error("ELEVENLABS_VOICE_ID belum diisi (pilih suara Bahasa Indonesia di ElevenLabs)");
  const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      // language_code hanya diterima model Turbo/Flash v2.5; multilingual v2 mengenali bahasa dari teksnya.
      text, model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true },
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
  const j = await res.json() as { audio_base64: string; alignment?: Parameters<typeof wordsFromAlignment>[0]; normalized_alignment?: Parameters<typeof wordsFromAlignment>[0] };
  const align = j.alignment ?? j.normalized_alignment;
  if (!j.audio_base64 || !align?.characters?.length) throw new Error("ElevenLabs tidak mengembalikan audio + cap waktu");
  const file = path.join(dir, "voice.mp3");
  await writeFile(file, Buffer.from(j.audio_base64, "base64"));
  const words = normalizeWords(wordsFromAlignment(align));
  if (!words.length) throw new Error("Cap waktu ElevenLabs kosong");
  return { provider: "elevenlabs", file, words, speechSec: words.at(-1)!.end, chars: text.length };
}
