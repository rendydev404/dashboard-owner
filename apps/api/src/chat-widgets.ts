// Widget chat dibangun dari hasil query (angka pasti), lalu dikirim ke browser sebagai event "widget".
// Model hanya menulis narasi; angka di kartu/grafik tidak pernah berasal dari teks model.
import type { ChatWidget, CampaignRow, HourlyResp, Kpis, PlResp, ProductsResp, WidgetTone } from "@iklan/shared";

const r2 = (n: number) => Math.round(n * 100) / 100;

export function summaryWidgets(scope: string, period: string, compare: string, k: Kpis, prev: Kpis): ChatWidget[] {
  const jasa = k.leads > 0;
  const kpis: ChatWidget = {
    kind: "kpis", title: `Ringkasan · ${scope}`, subtitle: `${period} · dibanding ${compare}`,
    items: [
      { label: "Laba bersih", value: Math.round(k.net), prev: Math.round(prev.net), format: "rp", upIsGood: true },
      { label: "Omzet riil", value: Math.round(k.revenue), prev: Math.round(prev.revenue), format: "rp", upIsGood: true, hint: `${k.orders} order` },
      { label: "Spend iklan", value: Math.round(k.spend), prev: Math.round(prev.spend), format: "rp", upIsGood: false },
      { label: "ROAS riil", value: r2(k.roas), prev: r2(prev.roas), format: "x", upIsGood: true },
      jasa
        ? { label: "CPL", value: Math.round(k.cpl), prev: Math.round(prev.cpl), format: "rp", upIsGood: false, hint: `${k.leads} leads` }
        : { label: "CPA", value: Math.round(k.cpa), prev: Math.round(prev.cpa), format: "rp", upIsGood: false },
      { label: "CTR", value: k.ctr, prev: prev.ctr, format: "pct", upIsGood: true },
    ],
  };
  const out: ChatWidget[] = [kpis];
  if (k.spend > 0 && k.beRoas > 0)
    out.push({
      kind: "progress", title: "ROAS riil vs titik impas", subtitle: "100% = balik modal setelah fee, HPP & PPN iklan",
      items: [{ label: "ROAS riil", value: r2(k.roas), target: r2(k.beRoas), format: "x", hint: k.roas >= k.beRoas ? "Sudah untung" : "Masih di bawah impas" }],
    });
  return out;
}

const recTone = (code: string): WidgetTone => (code === "scale" ? "good" : code === "kill" ? "bad" : code === "creative" ? "warn" : "neutral");

export function campaignsWidget(scope: string, period: string, rows: CampaignRow[]): ChatWidget | null {
  const live = rows.filter((x) => x.spend > 0).slice(0, 8);
  if (!live.length) return null;
  return {
    kind: "bars", title: `Kampanye · ${scope}`, subtitle: `Spend ${period}`, format: "rp",
    items: live.map((x) => ({
      label: x.name, value: Math.round(x.spend), tone: recTone(x.rec.code),
      sub: `${x.line === "jasa" ? `${x.leads} leads${x.cpl ? ` · CPL Rp${Math.round(x.cpl).toLocaleString("id-ID")}` : ""}` : `ROAS ${r2(x.roas).toString().replace(".", ",")}x`} · ${x.rec.label}`,
    })),
  };
}

export function hourlyWidget(h: HourlyResp): ChatWidget | null {
  const rows = h.hours.filter((x) => x.spend > 0 && x.results > 0 && x.cost);
  if (!rows.length) return null;
  const best = [...rows].sort((a, b) => a.cost! - b.cost!).slice(0, 6);
  const unit = h.metric === "leads" ? "lead" : "pembelian";
  return {
    kind: "bars", title: "Jam paling cuan", subtitle: `Biaya per ${unit} terendah (makin pendek makin hemat)`, format: "rp",
    items: best.map((x, i) => ({ label: `${String(x.hour).padStart(2, "0")}:00`, value: Math.round(x.cost!), sub: `${x.results} ${unit} · spend Rp${Math.round(x.spend).toLocaleString("id-ID")}`, tone: i < 2 ? "good" : "neutral" })),
  };
}

export function productsWidget(period: string, p: ProductsResp): ChatWidget | null {
  if (!p.rows.length) return null;
  return {
    kind: "bars", title: "Produk & jasa terlaris", subtitle: `Omzet ${period}`, format: "rp",
    items: p.rows.slice(0, 8).map((x) => ({ label: x.name, value: Math.round(x.revenue), sub: `${x.qty} terjual · ${(x.share * 100).toFixed(1).replace(".", ",")}% omzet` })),
  };
}

export function plWidget(period: string, p: PlResp): ChatWidget {
  return {
    kind: "kpis", title: "Laba rugi per lini", subtitle: period,
    items: p.columns.map((c) => ({ label: c.label, value: Math.round(c.kpis.net), prev: c.prevNet, format: "rp" as const, upIsGood: true, hint: `omzet Rp${Math.round(c.kpis.revenue).toLocaleString("id-ID")}` })),
  };
}
