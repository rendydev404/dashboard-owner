import { useCallback } from "react";
import { ShoppingBag, Package, Receipt, Wallet, Percent, BadgeDollarSign, Tag, CircleCheck, CircleAlert, Info } from "lucide-react";
import { rp, rpk, dec, pct, nf, type LynkResp } from "@iklan/shared";
import { useLynk, useBootstrap } from "../lib/api";
import { setView } from "../lib/view";
import { Card, CardHead, EmptyState, ErrorState, Skeleton, cx } from "../components/ui";
import { KpiCard, KpiSkeleton } from "../components/kpi";
import { ChartCanvas, baseOptions } from "../components/charts";

const ic = 16;
const when = (iso: string) => new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function cards(d: LynkResp) {
  const k = d.kpis, p = d.prev;
  return [
    { label: "Order", value: nf(k.orders), sub: `${nf(k.items)} item terjual`, cur: k.orders, prev: p.orders, goodUp: true as boolean | null, icon: <ShoppingBag size={ic} />, highlight: true },
    { label: "Pendapatan bersih", value: rpk(k.net), sub: `setelah PPN lynk ${dec(d.ppnPct, 0)}%`, cur: k.net, prev: p.net, goodUp: true, icon: <Wallet size={ic} />, tone: "pos" as const },
    { label: "Pendapatan (grandTotal)", value: rpk(k.revenue), sub: "angka akhir dari lynk.id", cur: k.revenue, prev: p.revenue, goodUp: true, icon: <Receipt size={ic} /> },
    { label: "AOV bersih", value: rpk(k.aov), sub: "bersih ÷ order", cur: k.aov, prev: p.aov, goodUp: true, icon: <BadgeDollarSign size={ic} /> },
    { label: "Omzet kotor", value: rpk(k.gross), sub: "harga + addon + ongkir", cur: k.gross, prev: p.gross, goodUp: true, icon: <Package size={ic} /> },
    { label: `PPN lynk (${dec(d.ppnPct, 0)}%)`, value: rpk(k.ppn), sub: "dari omzet kotor, manual", cur: k.ppn, prev: p.ppn, goodUp: null, icon: <Percent size={ic} /> },
    { label: "Diskon & biaya layanan", value: rpk(k.discount), sub: "omzet kotor − grandTotal", cur: k.discount, prev: p.discount, goodUp: null, icon: <Tag size={ic} /> },
    { label: "Item per order", value: dec(k.orders ? k.items / k.orders : 0, 1), sub: "rata-rata", cur: k.orders ? k.items / k.orders : 0, prev: p.orders ? p.items / p.orders : 0, goodUp: true, icon: <ShoppingBag size={ic} /> },
  ];
}

export default function LynkStats() {
  const { data: d, error, isLoading, refetch, isPlaceholderData } = useLynk();
  const boot = useBootstrap().data!;

  const trend = useCallback((c: (v: string) => string) => {
    const pts = d!.series.points, base = baseOptions(c);
    return {
      type: "bar",
      data: {
        labels: pts.map((x) => x.label),
        datasets: [
          { type: "bar", label: "Pendapatan bersih", data: pts.map((x) => x.net), backgroundColor: c("--accent"), borderRadius: 99, borderSkipped: false, maxBarThickness: 12, order: 2 },
          { type: "line", label: "Order", data: pts.map((x) => x.orders), borderColor: c("--yellow"), backgroundColor: c("--yellow"), yAxisID: "y2", tension: 0.4, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.2, order: 1 },
        ],
      },
      options: {
        ...base,
        plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: { label: (t: any) => `${t.dataset.label}: ${t.dataset.yAxisID === "y2" ? nf(t.raw) : rp(t.raw)}` } } },
        scales: { ...base.scales, y2: { position: "right", beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { color: c("--muted"), precision: 0, font: { size: 11 } } } },
      },
    } as any;
  }, [d]);

  const hours = useCallback((c: (v: string) => string) => {
    const base = baseOptions(c);
    return {
      type: "bar",
      data: { labels: d!.hours.map((h) => String(h.hour).padStart(2, "0")), datasets: [{ label: "Order", data: d!.hours.map((h) => h.orders), backgroundColor: c("--yellow"), borderRadius: 99, borderSkipped: false, maxBarThickness: 12 }] },
      options: { ...base, plugins: { ...base.plugins, legend: { display: false }, tooltip: { ...base.plugins.tooltip, callbacks: { title: (t: any) => `Jam ${t[0].label}:00`, label: (t: any) => `${nf(t.raw)} order` } } }, scales: { ...base.scales, y: { ...base.scales.y, ticks: { ...base.scales.y.ticks, callback: (v: number) => nf(v), precision: 0 } } } },
    } as any;
  }, [d]);

  if (error && !d) return <Card><ErrorState error={error} onRetry={() => refetch()} /></Card>;
  if (isLoading || !d) return <div className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <KpiSkeleton key={i} />)}</div>;

  const w = d.webhook;
  const noData = !d.kpis.orders;
  const maxProd = Math.max(1, ...d.products.map((p) => p.revenue));
  return (
    <div className={cx("space-y-3 transition-opacity md:space-y-4", isPlaceholderData && "opacity-70")}>
      {/* Status webhook: selalu terlihat supaya jelas data lynk.id masuk atau belum */}
      <div className={cx("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-2.5 text-[13px]", w.lastAt ? "border-line bg-card" : "border-accent/30 bg-accent-soft")}>
        {w.lastAt ? <CircleCheck size={16} className="shrink-0 text-green" /> : <CircleAlert size={16} className="shrink-0 text-accent" />}
        <span><b>Webhook lynk.id</b> · {!w.configured ? "belum dikonfigurasi di server" : w.lastAt ? `transaksi terakhir ${when(w.lastAt)}` : "belum ada transaksi yang masuk"}</span>
        <span className="text-muted">{nf(w.valid)} event valid{w.invalid ? ` · ${nf(w.invalid)} ditolak (tanda tangan salah)` : ""}</span>
        <button className="ml-auto font-semibold text-accent hover:underline" onClick={() => setView({ tab: "pengaturan" })}>URL webhook</button>
      </div>

      {noData ? (
        <Card>
          <EmptyState icon={<ShoppingBag size={20} />} title="Belum ada penjualan lynk.id di periode ini"
            text={w.lastAt ? "Coba pilih periode lain." : "Statistik terisi otomatis begitu webhook menerima transaksi. Riwayat lama di VPS bisa diimpor, caranya ada di deploy/lynk-forward.md."} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">{cards(d).map((x) => <KpiCard key={x.label} {...x} />)}</div>

          <div className="grid gap-3 md:gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHead title={d.series.granularity === "hour" ? "Pendapatan per jam" : "Pendapatan per hari"} hint={`Bar = pendapatan bersih (setelah PPN ${dec(d.ppnPct, 0)}%), garis = jumlah order`} />
              <ChartCanvas build={trend} height={260} label="Grafik pendapatan bersih dan order lynk.id" />
            </Card>
            <Card>
              <CardHead title="Jam ramai pembeli" hint="Jumlah order per jam (WIB)" />
              <ChartCanvas build={hours} height={260} label="Grafik order per jam" />
            </Card>
          </div>

          <div className="grid gap-3 md:gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHead title="Produk terlaris" hint="Dari penjualan lynk.id di periode terpilih. Bar = porsi omzet." />
              <div className="-mx-5 overflow-x-auto px-5">
                <table className="w-full min-w-[460px] text-[13px]">
                  <thead><tr className="text-[12px] text-muted"><th className="pb-3 text-left font-medium">Produk</th><th className="px-3 pb-3 text-right font-medium">Terjual</th><th className="px-3 pb-3 text-right font-medium">Omzet</th><th className="w-[130px] pb-3 pl-3 text-left font-medium">Porsi</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {d.products.map((p) => (
                      <tr key={p.name}>
                        <td className="max-w-[280px] py-3 pr-3 font-medium"><span className="block break-words">{p.name}</span></td>
                        <td className="num px-3 py-3 text-right">{nf(p.qty)}</td><td className="num px-3 py-3 text-right font-semibold">{rpk(p.revenue)}</td>
                        <td className="py-3 pl-3"><div className="num text-[12px]">{pct(p.share)}</div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-track"><div className="h-full rounded-full bg-accent" style={{ width: `${(p.revenue / maxProd) * 100}%` }} /></div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card>
              <CardHead title="Transaksi terbaru" hint="10 transaksi terakhir yang masuk" />
              <ul className="divide-y divide-line">
                {d.recent.map((x, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                    <div className="min-w-0"><p className="truncate font-medium">{x.product}{x.qty > 1 ? ` ×${x.qty}` : ""}</p><p className="text-[12px] text-muted">{when(x.at)}</p></div>
                    <span className="num shrink-0 font-semibold text-green-ink">{rpk(x.revenue)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </>
      )}
      <p className="flex items-start gap-2 px-1 text-[12px] text-muted"><Info size={14} className="mt-0.5 shrink-0" /> Pendapatan = grandTotal dari lynk.id. PPN lynk {dec(d.ppnPct, 0)}% dihitung manual dari omzet kotor (harga + addon + ongkir), sesuai aturan laporan hermes-ads. Ubah persentasenya di Pengaturan → Fee platform.{boot.user.role !== "owner" && " (hanya owner yang bisa mengubah)"}</p>
    </div>
  );
}
