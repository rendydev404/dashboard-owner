// Semua tanggal berupa string "YYYY-MM-DD" (zona Asia/Jakarta). Aritmetika memakai UTC
// supaya tidak terpengaruh zona waktu mesin (server di Docker, browser di HP).

export const TZ = "Asia/Jakarta";

export const PRESETS = [
  "today", "yesterday", "7d", "thisweek", "lastweek", "30d", "thismonth", "lastmonth", "90d",
] as const;
export type Preset = (typeof PRESETS)[number];
export type RangePreset = Preset | "custom";

export const PRESET_LABELS: Record<RangePreset, string> = {
  today: "Hari ini", yesterday: "Kemarin", "7d": "7 hari terakhir", thisweek: "Minggu ini",
  lastweek: "Minggu lalu", "30d": "30 hari terakhir", thismonth: "Bulan ini", lastmonth: "Bulan lalu",
  "90d": "90 hari terakhir", custom: "Custom",
};

const pad = (n: number) => String(n).padStart(2, "0");
const toDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const toKey = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export const isDateKey = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && toKey(toDate(s)) === s;

export function addDays(s: string, n: number): string {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toKey(d);
}
export const lenDays = (s: string, e: string) => Math.round((toDate(e).getTime() - toDate(s).getTime()) / 864e5) + 1;
const monthStart = (y: number, m: number) => toKey(new Date(Date.UTC(y, m, 1)));
const monthEnd = (y: number, m: number) => toKey(new Date(Date.UTC(y, m + 1, 0)));
const minK = (a: string, b: string) => (a < b ? a : b);

/** Tanggal hari ini di Jakarta. */
export function todayKey(now: Date = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
/** Jam sekarang (0–23) di Jakarta. */
export function hourNow(now: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(now));
}

export function presetRange(p: Preset, today: string): [string, string] {
  const t = toDate(today);
  const dow = (t.getUTCDay() + 6) % 7; // Senin = 0
  const y = t.getUTCFullYear(), m = t.getUTCMonth();
  switch (p) {
    case "today": return [today, today];
    case "yesterday": return [addDays(today, -1), addDays(today, -1)];
    case "7d": return [addDays(today, -6), today];
    case "thisweek": return [addDays(today, -dow), today];
    case "lastweek": return [addDays(today, -dow - 7), addDays(today, -dow - 1)];
    case "30d": return [addDays(today, -29), today];
    case "thismonth": return [monthStart(y, m), today];
    case "lastmonth": return [monthStart(y, m - 1), monthEnd(y, m - 1)];
    case "90d": return [addDays(today, -89), today];
  }
}

/** Rentang dimulai tanggal 1 dan berada di bulan yang sama → diperlakukan sebagai bulan kalender. */
export function isMonthRange(s: string, e: string): boolean {
  const a = toDate(s), b = toDate(e);
  return a.getUTCDate() === 1 && a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear();
}

export function shiftRange(s: string, e: string, dir: 1 | -1, today: string): [string, string] {
  if (isMonthRange(s, e)) {
    const a = toDate(s);
    const y = a.getUTCFullYear(), m = a.getUTCMonth() + dir;
    return [monthStart(y, m), minK(monthEnd(y, m), today)];
  }
  const L = lenDays(s, e);
  return [addDays(s, dir * L), addDays(e, dir * L)];
}

/** Periode pembanding: bulan kalender → bulan sebelumnya dengan jumlah hari sama; selain itu periode sebelumnya. */
export function compareRange(s: string, e: string): [string, string] {
  if (isMonthRange(s, e)) {
    const a = toDate(s);
    const y = a.getUTCFullYear(), m = a.getUTCMonth() - 1;
    const ps = monthStart(y, m);
    return [ps, minK(addDays(ps, lenDays(s, e) - 1), monthEnd(y, m))];
  }
  const L = lenDays(s, e);
  return [addDays(s, -L), addDays(e, -L)];
}

/** Rapikan rentang dari input user: urutkan, potong ke hari ini. */
export function clampRange(s: string, e: string, today: string): [string, string] {
  if (s > e) [s, e] = [e, s];
  return [minK(s, today), minK(e, today)];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
export function fmtDate(s: string, withYear = true): string {
  const d = toDate(s);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${withYear ? " " + d.getUTCFullYear() : ""}`;
}
export function fmtRange(s: string, e: string): string {
  if (s === e) return fmtDate(s);
  const sameYear = s.slice(0, 4) === e.slice(0, 4);
  if (sameYear && s.slice(0, 7) === e.slice(0, 7)) return `${toDate(s).getUTCDate()}–${fmtDate(e)}`;
  return `${fmtDate(s, !sameYear)} – ${fmtDate(e)}`;
}

export function eachDay(s: string, e: string): string[] {
  const out: string[] = [];
  for (let d = s; d <= e; d = addDays(d, 1)) out.push(d);
  return out;
}
