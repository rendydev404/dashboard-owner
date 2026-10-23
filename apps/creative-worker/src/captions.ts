// Subtitle gaya Reels/TikTok: kata dikelompokkan jadi "halaman" pendek, kata yang sedang diucapkan disorot.
// Fungsi murni (tanpa React/Remotion) supaya mudah diuji.
import type { Word } from "./schema";

export interface Page { words: Word[]; start: number; end: number }
export interface GroupOpts { maxWords: number; maxChars: number; maxGap: number }
const DEFAULTS: GroupOpts = { maxWords: 4, maxChars: 20, maxGap: 0.6 };

/** Cap waktu karakter ElevenLabs (alignment) → kata. Spasi/baris baru memisahkan kata. */
export function wordsFromAlignment(a: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }): Word[] {
  const out: Word[] = [];
  let cur = "", start = 0, end = 0;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) { out.push({ text: cur, start, end }); cur = ""; }
      return;
    }
    if (!cur) start = a.character_start_times_seconds[i];
    cur += ch;
    end = a.character_end_times_seconds[i];
  });
  if (cur) out.push({ text: cur, start, end });
  return out;
}

/** Rapikan cap waktu: urut, tidak negatif, dan tiap kata minimal 80 ms. */
export function normalizeWords(words: Word[]): Word[] {
  let t = 0;
  return words.map((w) => {
    const start = Math.max(w.start, t);
    const end = Math.max(w.end, start + 0.08);
    t = end;
    return { text: w.text, start, end };
  });
}

/** Kelompokkan kata jadi halaman subtitle. Pisah di akhir kalimat, jeda panjang, atau kalau kepanjangan. */
export function groupWords(input: Word[], opts: Partial<GroupOpts> = {}): Page[] {
  const o = { ...DEFAULTS, ...opts };
  const words = normalizeWords(input);
  const pages: Word[][] = [];
  let cur: Word[] = [];
  const len = (ws: Word[]) => ws.map((w) => w.text).join(" ").length;
  words.forEach((w, i) => {
    const prev = cur[cur.length - 1];
    const brk = cur.length > 0 && (
      cur.length >= o.maxWords || len([...cur, w]) > o.maxChars || w.start - prev.end > o.maxGap || /[.!?…]$/.test(prev.text) ||
      (/[,;:]$/.test(prev.text) && cur.length >= 2)
    );
    if (brk) { pages.push(cur); cur = []; }
    cur.push(w);
    if (i === words.length - 1) pages.push(cur);
  });
  return pages.map((ws, i) => {
    const next = pages[i + 1]?.[0];
    const last = ws[ws.length - 1];
    // Halaman bertahan sebentar setelah kata terakhir, tapi tidak melewati halaman berikutnya (tanpa tumpang tindih).
    const end = next ? Math.min(next.start, last.end + 0.25) : last.end + 0.25;
    return { words: ws, start: ws[0].start, end };
  });
}

/**
 * Cap waktu perkiraan dari teks saja (video tanpa suara, atau suara belum tersedia): durasi kata ∝ panjangnya,
 * jeda di tanda baca. Tempo ±2,6 kata/detik, setara pembaca iklan berbahasa Indonesia.
 */
export function estimateWords(text: string, startAt = 0.3): Word[] {
  const words: Word[] = [];
  let t = startAt;
  for (const raw of text.trim().split(/\s+/).filter(Boolean)) {
    const d = 0.12 + 0.05 * raw.replace(/[^\p{L}\p{N}]/gu, "").length;
    words.push({ text: raw, start: +t.toFixed(3), end: +(t + d).toFixed(3) });
    t += d + (/[.!?]$/.test(raw) ? 0.3 : /[,;:]$/.test(raw) ? 0.14 : 0.04);
  }
  return words;
}

/** Halaman yang tampil pada detik t (null di jeda). */
export const pageAt = (pages: Page[], t: number) => pages.find((p) => t >= p.start && t < p.end) ?? null;

/** Indeks kata yang sedang diucapkan pada detik t di halaman ini. */
export function activeWord(page: Page, t: number): number {
  let idx = 0;
  page.words.forEach((w, i) => { if (t >= w.start) idx = i; });
  return idx;
}
