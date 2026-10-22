// Rumus KPI & laba rugi (PRD §8). Input berupa total yang SUDAH diagregasi di database,
// jadi fungsi ini hanya mengolah beberapa baris angka.

export type Line = "digital" | "jasa";
export const LINES: Record<Line, { label: string; src: string }> = {
  digital: { label: "Produk Digital AI", src: "Otomatis · lynk.id" },
  jasa: { label: "Jasa AI", src: "Input manual" },
};

export interface AdTotals {
  accountId: string;
  line: Line;
  spend: number; impr: number; clicks: number; leads: number; purchases: number; metaRev: number;
  adTaxPct: number;
}
/** feeBase = omzet kotor sebagai dasar fee/PPN platform (kosong → pakai revenue). */
export interface SalesTotals { line: Line; revenue: number; orders: number; cogs: number; feeBase?: number }
/** `fixed` = biaya tetap yang jatuh di periode ini (sudah prorata sesuai hari aktif tiap biaya). */
export interface LineCosts { line: Line; feePct: number; fixed: number; other: number }

export interface Kpis {
  days: number;
  spend: number; impr: number; clicks: number; leads: number; results: number; metaRev: number;
  revenue: number; orders: number; jasaOrders: number;
  fee: number; cogs: number; gross: number; adTax: number; fixed: number; other: number; net: number;
  roas: number; metaRoas: number; cpa: number; cpl: number; closeRate: number; ctr: number; cpc: number; aov: number;
  margin: number; netMargin: number; beRoas: number; profitPerOrder: number; maxCpaBE: number;
}

export const div = (a: number, b: number) => (b ? a / b : 0);

export function computeKpis(input: {
  days: number;
  lines: Line[];
  ads: AdTotals[];
  sales: SalesTotals[];
  costs: LineCosts[];
}): Kpis {
  const { days } = input;
  const inLine = <T extends { line: Line }>(x: T) => input.lines.includes(x.line);
  const ads = input.ads.filter(inLine), sales = input.sales.filter(inLine), costs = input.costs.filter(inLine);
  const sum = <T>(arr: T[], f: (x: T) => number) => arr.reduce((t, x) => t + f(x), 0);

  const spend = sum(ads, (a) => a.spend);
  const adTax = sum(ads, (a) => (a.spend * a.adTaxPct) / 100);
  const revenue = sum(sales, (s) => s.revenue);
  const orders = sum(sales, (s) => s.orders);
  const cogs = sum(sales, (s) => s.cogs);
  const fee = sum(costs, (c) => (sum(sales.filter((s) => s.line === c.line), (s) => s.feeBase ?? s.revenue) * c.feePct) / 100);
  const fixed = sum(costs, (c) => c.fixed);
  const other = sum(costs, (c) => c.other);
  const leads = sum(ads, (a) => a.leads);
  const leadSpend = sum(ads.filter((a) => a.line === "jasa" || a.leads > 0), (a) => a.spend);
  const clicks = sum(ads, (a) => a.clicks);
  const impr = sum(ads, (a) => a.impr);
  const jasaOrders = sum(sales.filter((s) => s.line === "jasa"), (s) => s.orders);
  const gross = revenue - fee - cogs;
  const net = gross - spend - adTax - fixed - other;
  const taxRate = div(adTax, spend) || 0.03;
  const margin = div(gross, revenue);

  return {
    days, spend, impr, clicks, leads, results: sum(ads, (a) => a.purchases), metaRev: sum(ads, (a) => a.metaRev),
    revenue, orders, jasaOrders, fee, cogs, gross, adTax, fixed, other, net,
    roas: div(revenue, spend),
    metaRoas: div(sum(ads, (a) => a.metaRev), spend),
    cpa: div(spend + adTax, orders),
    cpl: div(leadSpend, leads),
    closeRate: div(jasaOrders, leads),
    ctr: div(clicks, impr),
    cpc: div(spend, clicks),
    aov: div(revenue, orders),
    margin,
    netMargin: div(net, revenue),
    beRoas: div(1 + taxRate, margin),
    profitPerOrder: div(net, orders),
    maxCpaBE: div(div(gross, orders), 1 + taxRate),
  };
}

/** Perubahan relatif; null kalau tidak ada pembanding. */
export function delta(cur: number, prev: number | null | undefined): number | null {
  if (!prev) return null;
  return (cur - prev) / Math.abs(prev);
}
