// Format angka & rupiah (id-ID) dan parser nominal bebas ("7,5jt", "750rb", "7.500.000").

const finite = (n: number) => (Number.isFinite(n) ? n : 0);

export const nf = (n: number) => Math.round(finite(n)).toLocaleString("id-ID");
export const rp = (n: number) => (n < 0 ? "-" : "") + "Rp" + Math.round(Math.abs(finite(n))).toLocaleString("id-ID");
export const dec = (n: number, d = 2) => finite(n).toFixed(d).replace(".", ",");
export const pct = (n: number, d = 1) => dec(finite(n) * 100, d) + "%";

/** Rupiah singkat: Rp1,25 jt · Rp450 rb · Rp2,10 M. Tak hingga → "—". */
export function rpk(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e9) return `${s}Rp${dec(a / 1e9)} M`;
  if (a >= 1e6) return `${s}Rp${dec(a / 1e6)} jt`;
  if (a >= 1e3) return `${s}Rp${Math.round(a / 1e3)} rb`;
  return `${s}Rp${Math.round(a)}`;
}

/** Angka ringkas untuk sumbu grafik: 400k, 1,2jt. */
export function shortNum(n: number): string {
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e9) return s + dec(a / 1e9, 1).replace(",0", "") + "M";
  if (a >= 1e6) return s + dec(a / 1e6, 1).replace(",0", "") + "jt";
  if (a >= 1e3) return s + Math.round(a / 1e3) + "k";
  return s + Math.round(a);
}

const UNITS: Record<string, number> = { jt: 1e6, juta: 1e6, rb: 1e3, ribu: 1e3, k: 1e3, m: 1e9, miliar: 1e9, milyar: 1e9 };

/**
 * Nominal bebas → rupiah bulat. Contoh: "7.500.000", "7,5jt", "750rb", "500k", "Rp 1.250.000", "25 juta".
 * Tanpa satuan, titik dan koma dianggap pemisah ribuan. Input tidak valid → 0.
 */
export function parseRp(v: unknown): number {
  const s = String(v ?? "").toLowerCase().replace(/rp|\s/g, "");
  if (!s) return 0;
  const m = s.match(/^([\d.,]+)(jt|juta|rb|ribu|k|miliar|milyar|m)?$/);
  if (!m) return 0;
  const [, num, unit] = m;
  if (unit) {
    const n = Number(num.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? Math.round(n * UNITS[unit]) : 0;
  }
  return Number(num.replace(/[.,]/g, "")) || 0;
}
