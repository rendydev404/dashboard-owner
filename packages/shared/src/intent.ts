// Pengurai perintah sederhana untuk bot (porting dari localBot() prototipe).
// Dipakai di browser supaya perintah pindah akun/periode/aturan instan tanpa memanggil AI.
import type { Preset } from "./dates";
import type { Line } from "./metrics";
import { parseRp } from "./money";

export type RuleField = "targetRoas" | "maxCpa" | "maxCpl" | "killAfterSpend" | "scaleStepPct";

export interface Intent {
  /** "all" | "digital" | "jasa" | id akun */
  acc?: string;
  preset?: Preset;
  rule?: { field: RuleField; value: number };
  confirm?: "yes" | "no";
  /** Kata kerja aksi kampanye kalau ada (dieksekusi lewat AI/backend, bukan lokal). */
  campaignAction?: "pause" | "activate" | "scale";
  /** Sisa teks berisi pertanyaan/permintaan lain selain pindah tampilan. */
  hasQuestion: boolean;
}

const PERIODS: [RegExp, Preset][] = [
  [/hari ini|today/, "today"],
  [/kemarin|yesterday/, "yesterday"],
  [/(minggu|pekan) lalu/, "lastweek"],
  [/(minggu|pekan) ini/, "thisweek"],
  [/bulan lalu/, "lastmonth"],
  [/bulan ini/, "thismonth"],
  [/90 ?hari|3 bulan/, "90d"],
  [/30 ?hari/, "30d"],
  [/7 ?hari|seminggu/, "7d"],
];

const VIEW_WORDS = /\b(akun|semua|gabung(an)?|digital|jasa|lynk|tampil(kan)?|lihat|buka|pindah|ke|dong|tolong|ya|hari|ini|kemarin|minggu|pekan|bulan|lalu|terakhir|\d+|seminggu)\b/g;

export function parseIntent(raw: string, accounts: { id: string; name: string; line: Line }[]): Intent {
  const t = raw.toLowerCase().trim();
  const it: Intent = { hasQuestion: false };

  if (/^(ya|y|iya|yes|ok|oke|gas|lanjut|boleh|sip|eksekusi)\b/.test(t) && t.split(/\s+/).length <= 3) it.confirm = "yes";
  else if (/^(tidak|ga|gak|nggak|enggak|batal|no|jangan|cancel)\b/.test(t) && t.split(/\s+/).length <= 3) it.confirm = "no";
  if (it.confirm) return it;

  let m: RegExpMatchArray | null;
  const num = String.raw`([\d.,]+\s*(?:jt|juta|rb|ribu|k)?)`;
  if ((m = t.match(/target roas\s*(?:jadi|ke|=)?\s*([\d.,]+)/))) it.rule = { field: "targetRoas", value: Number(m[1].replace(",", ".")) || 0 };
  else if ((m = t.match(new RegExp(`batas cpa\\s*(?:jadi|ke|=)?\\s*${num}`)))) it.rule = { field: "maxCpa", value: parseRp(m[1]) };
  else if ((m = t.match(new RegExp(`batas cpl\\s*(?:jadi|ke|=)?\\s*${num}`)))) it.rule = { field: "maxCpl", value: parseRp(m[1]) };
  else if ((m = t.match(new RegExp(`(?:matikan|kill) (?:setelah|sesudah) spend\\s*${num}`)))) it.rule = { field: "killAfterSpend", value: parseRp(m[1]) };
  else if ((m = t.match(/(?:langkah|step) scale\s*(?:jadi|ke|=)?\s*(\d+)/))) it.rule = { field: "scaleStepPct", value: Number(m[1]) };

  if (/\b(pause|matikan|stop|jeda)\b/.test(t) && !it.rule) it.campaignAction = "pause";
  else if (/\b(aktifkan|nyalakan|hidupkan|jalankan)\b/.test(t)) it.campaignAction = "activate";
  else if (/\b(scale|naikkan|naikin)\b/.test(t)) it.campaignAction = "scale";

  if (/\b(semua|gabung|gabungan)\b/.test(t)) it.acc = "all";
  else if (/\bjasa\b/.test(t) && !/input/.test(t)) it.acc = accounts.some((a) => a.line === "jasa") ? "jasa" : undefined;
  else if (/\b(digital|lynk)\b/.test(t)) it.acc = accounts.some((a) => a.line === "digital") ? "digital" : undefined;
  else {
    const a = accounts.find((x) => t.includes(x.id) || t.includes(x.name.toLowerCase()));
    if (a) it.acc = a.id;
  }

  const p = PERIODS.find(([re]) => re.test(t));
  if (p) it.preset = p[1];

  // Ada pertanyaan kalau setelah membuang kata-kata tampilan masih tersisa kata bermakna.
  const rest = t.replace(VIEW_WORDS, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  it.hasQuestion = !it.rule && (rest.length > 0 || !!it.campaignAction);
  return it;
}
