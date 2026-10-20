import { useCallback } from "react";
import { Megaphone, Eye, MousePointerClick, Percent, Coins, ShoppingCart, BadgeDollarSign, Target, Users, Gauge, Info } from "lucide-react";
import { rp, rpk, dec, pct, nf, LINES, type FbResp, type FbKpis } from "@iklan/shared";
import { useFb } from "../lib/api";
import { Card, CardHead, EmptyState, ErrorState, Skeleton, cx } from "../components/ui";
import { KpiCard, KpiSkeleton } from "../components/kpi";
import { ChartCanvas, baseOptions } from "../components/charts";

const ic = 16;
type Card_ = { label: string; value: string; sub?: string; cur: number; prev: number; goodUp: boolean | null; icon: React.ReactNode };

function cards(d: FbResp): Card_[] {
  const k: FbKpis = d.kpis, p: FbKpis = d.prev;
  const out: Card_[] = [
    { label: "Spend iklan", value: rpk(k.spend), sub: `${nf(k.impressions)} impresi`, cur: k.spend, prev: p.spend, goodUp: null, icon: <Megaphone size={ic} /> },
    { label: "Impresi", value: nf(k.impressions), sub: `CPM ${rpk(k.cpm)}`, cur: k.impressions, prev: p.impressions, goodUp: true, icon: <Eye size={ic} /> },
    { label: "Klik link", value: nf(k.clicks), sub: `CPC ${rpk(k.cpc)}`, cur: k.clicks, prev: p.clicks, goodUp: true, icon: <MousePointerClick size={ic} /> },
    { label: "CTR", value: pct(k.ctr, 2), sub: "klik ÷ impresi", cur: k.ctr, prev: p.ctr, goodUp: true, icon: <Percent size={ic} /> },
  ];
  if (d.hasDigital) out.push(
    { label: "Pembelian (Meta)", value: nf(k.purchases), sub: `CPA ${k.purchases ? rpk(k.cpa) : "—"}`, cur: k.purchases, prev: p.purchases, goodUp: true, icon: <ShoppingCart size={ic} /> },
    { label: "Nilai pembelian (Meta)", value: rpk(k.purchaseValue), sub: "dari pixel Meta", cur: k.purchaseValue, prev: p.purchaseValue, goodUp: true, icon: <Coins size={ic} /> },
    { label: "ROAS Meta", value: `${dec(k.roas)}x`, sub: "nilai pixel ÷ spend", cur: k.roas, prev: p.roas, goodUp: true, icon: <Target size={ic} /> },
    { label: "CPA", value: k.purchases ? rpk(k.cpa) : "—", sub: "spend ÷ pembelian", cur: k.cpa, prev: p.cpa, goodUp: false, icon: <BadgeDollarSign size={ic} /> },
  );
  if (d.hasLeads) out.push(
    { label: "Leads", value: nf(k.leads), sub: "akun jasa", cur: k.leads, prev: p.leads, goodUp: true, icon: <Users size={ic} /> },
    { label: "CPL", value: k.leads ? rpk(k.cpl) : "—", sub: "spend ÷ lead", cur: k.cpl, prev: p.cpl, goodUp: false, icon: <Gauge size={ic} /> },
  );
  return out;
}

export default function FacebookAds() {
  const { data: d, error, isLoading, refetch, isPlaceholderData } = useFb();

  const spendChart = useCallback((c: (v: string) => string) => {
    const pts = d!.series.points, base = baseOptions(c);
    const lead = d!.hasLeads && !d!.hasDigital;
    return {
      type: "bar",
      data: {
        labels: pts.map((x) => x.label),
        datasets: [
          { type: "bar", label: "Spend", data: pts.map((x) => x.spend), backgroundColor: c("--accent"), borderRadius: 99, borderSkipped: false, maxBarThickness: 12, order: 2 },
          { type: "line", label: lead ? "Leads" : "Pembelian (Meta)", data: pts.map((x) => (lead ? x.leads : x.purchases)), borderColor: c("--violet-a"), backgroundColor: c("--violet-a"), yAxisID: "y2", tension: 0.4, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.2, order: 1 },
        ],
      },
      options: {
        ...base,
        plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: { label: (t: any) => `${t.dataset.label}: ${t.dataset.yAxisID === "y2" ? nf(t.raw) : rp(t.raw)}` } } },
        scales: { ...base.scales, y2: { position: "right", beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { color: c("--muted"), precision: 0, font: { size: 11 } } } },
      },
    } as any;
  }, [d]);

  const valueChart = useCallback((c: (v: string) => string) => {
    const pts = d!.series.points, base = baseOptions(c);
    return {
      type: "bar",
      data: {
        labels: pts.map((x) => x.label),
        datasets: [
          { type: "bar", label: "Spend", data: pts.map((x) => x.spend), backgroundColor: c("--accent"), borderRadius: 99, borderSkipped: false, barPercentage: 0.6, maxBarThickness: 10, order: 3 },
          { type: "bar", label: "Nilai pembelian (Meta)", data: pts.map((x) => x.purchaseValue), backgroundColor: c("--yellow"), borderRadius: 99, borderSkipped: false, barPercentage: 0.6, maxBarThickness: 10, order: 2 },
          { type: "line", label: "ROAS Meta", data: pts.map((x) => (x.spend ? x.purchaseValue / x.spend : 0)), borderColor: c("--green"), backgroundColor: c("--green"), yAxisID: "y2", tension: 0.4, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.2, order: 1 },
        ],
      },
      options: {
        ...base,
        plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: { label: (t: any) => `${t.dataset.label}: ${t.dataset.yAxisID === "y2" ? dec(t.raw) + "x" : rp(t.raw)}` } } },
        scales: { ...base.scales, y2: { position: "right", beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { color: c("--muted"), font: { size: 11 }, callback: (v: number) => dec(v, 1) + "x" } } },
      },
    } as any;
  }, [d]);

  if (error && !d) return <Card><ErrorState error={error} onRetry={() => refetch()} /></Card>;
  if (isLoading || !d) return <div className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <KpiSkeleton key={i} />)}<div className="card col-span-2 h-[300px] p-5 xl:col-span-4"><Skeleton className="h-full" /></div></div>;

  const noData = !d.kpis.spend && !d.kpis.impressions;
  const kc = cards(d);
  return (
    <div className={cx("space-y-3 transition-opacity md:space-y-4", isPlaceholderData && "opacity-70")}>
      <div className="flex items-start gap-2 rounded-xl border border-line bg-card px-4 py-2.5 text-[12.5px] text-muted">
        <Info size={15} className="mt-0.5 shrink-0" />
        <span>Angka di tab ini murni dari <b className="text-ink">Meta Ads</b> (pixel Meta, bisa berbeda dari penjualan sebenarnya). Omzet dan laba riil ada di tab <b className="text-ink">lynk.id</b> dan <b className="text-ink">Ringkasan</b>.{d.lastSyncedAt && ` Data Meta terakhir: ${new Date(d.lastSyncedAt).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.`}</span>
      </div>

      {noData ? <Card><EmptyState icon={<Megaphone size={20} />} title="Belum ada data iklan di periode ini" text="Coba pilih periode lain, atau pastikan akun iklan sudah tersinkron." /></Card> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">{kc.map((x) => <KpiCard key={x.label} {...x} />)}</div>

          <div className="grid gap-3 md:gap-4 xl:grid-cols-2">
            <Card>
              <CardHead title={d.series.granularity === "hour" ? "Spend & hasil per jam" : "Spend & hasil per hari"} hint={d.hasLeads && !d.hasDigital ? "Bar = spend, garis = leads" : "Bar = spend, garis = pembelian menurut Meta"} />
              <ChartCanvas build={spendChart} height={260} label="Grafik spend dan hasil iklan" />
            </Card>
            {d.hasDigital && (
              <Card>
                <CardHead title="Spend vs nilai pembelian (Meta)" hint="Garis hijau = ROAS Meta. Nilai pembelian dari pixel, bukan omzet lynk.id" />
                <ChartCanvas build={valueChart} height={260} label="Grafik spend, nilai pembelian dan ROAS Meta" />
              </Card>
            )}
          </div>

          {d.accounts.length > 1 && (
            <Card>
              <CardHead title="Per akun iklan" hint="Perbandingan akun pada periode terpilih" />
              <div className="-mx-5 overflow-x-auto px-5">
                <table className="w-full min-w-[560px] text-[13px]">
                  <thead><tr className="text-[12px] text-muted"><th className="pb-3 text-left font-medium">Akun</th><th className="px-3 pb-3 text-right font-medium">Spend</th><th className="px-3 pb-3 text-right font-medium">Klik</th><th className="px-3 pb-3 text-right font-medium">Pembelian</th><th className="px-3 pb-3 text-right font-medium">Leads</th><th className="pb-3 pl-3 text-right font-medium">ROAS Meta</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {d.accounts.map((a) => (
                      <tr key={a.id}>
                        <td className="py-3"><span className="font-medium">{a.name}</span><span className="block text-[11.5px] text-muted">{LINES[a.line].label}</span></td>
                        <td className="num px-3 py-3 text-right">{rpk(a.spend)}</td><td className="num px-3 py-3 text-right">{nf(a.clicks)}</td>
                        <td className="num px-3 py-3 text-right">{nf(a.purchases)}</td><td className="num px-3 py-3 text-right">{nf(a.leads)}</td>
                        <td className="num py-3 pl-3 text-right font-semibold">{a.line === "digital" ? `${dec(a.roas)}x` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card>
            <CardHead title="Kampanye teratas" hint="10 kampanye dengan spend terbesar. Detail & aksi ada di menu Kampanye." />
            <div className="-mx-5 overflow-x-auto px-5">
              <table className="w-full min-w-[620px] text-[13px]">
                <thead><tr className="text-[12px] text-muted"><th className="pb-3 text-left font-medium">Kampanye</th><th className="px-3 pb-3 text-left font-medium">Status</th><th className="px-3 pb-3 text-right font-medium">Spend</th><th className="px-3 pb-3 text-right font-medium">Klik</th><th className="px-3 pb-3 text-right font-medium">CTR</th><th className="px-3 pb-3 text-right font-medium">Beli</th><th className="pb-3 pl-3 text-right font-medium">ROAS</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {d.campaigns.map((c) => (
                    <tr key={c.id}>
                      <td className="max-w-[300px] py-3 pr-3 font-medium"><span className="block break-words">{c.name}</span></td>
                      <td className="px-3 py-3"><span className={cx("pill", c.status === "ACTIVE" ? "bg-green-soft text-green-ink" : "bg-bg text-muted")}>{c.status === "ACTIVE" ? "Aktif" : "Jeda"}</span></td>
                      <td className="num whitespace-nowrap px-3 py-3 text-right">{rpk(c.spend)}</td><td className="num px-3 py-3 text-right">{nf(c.clicks)}</td>
                      <td className="num px-3 py-3 text-right">{pct(c.ctr)}</td><td className="num px-3 py-3 text-right">{nf(c.purchases)}</td>
                      <td className="num py-3 pl-3 text-right font-semibold">{dec(c.roas)}x</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
