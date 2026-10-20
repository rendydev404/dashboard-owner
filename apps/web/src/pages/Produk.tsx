import { ExternalLink, Package } from "lucide-react";
import { rpk, nf, pct, LINES } from "@iklan/shared";
import { useProducts } from "../lib/api";
import { Card, CardHead, EmptyState, ErrorState, Skeleton, cx } from "../components/ui";
import { Donut, Legend } from "../components/charts";

export default function Produk() {
  const { data: d, error, isLoading, refetch, isPlaceholderData } = useProducts();
  if (error && !d) return <Card><ErrorState error={error} onRetry={() => refetch()} /></Card>;
  if (isLoading || !d) return <Card><Skeleton className="h-[360px]" /></Card>;
  const max = Math.max(1, ...d.rows.map((r) => r.revenue));
  const byLine = (["digital", "jasa"] as const).map((l) => ({ line: l, revenue: d.rows.filter((r) => r.line === l).reduce((t, r) => t + r.revenue, 0) })).filter((x) => x.revenue > 0);
  const colors = { digital: "var(--accent)", jasa: "var(--yellow)" };

  return (
    <div className={cx("grid gap-3 transition-opacity md:gap-4 xl:grid-cols-4", isPlaceholderData && "opacity-70")}>
      <Card className="xl:col-span-3">
        <CardHead title="Produk & jasa terlaris" hint="Produk digital otomatis dari lynk.id, jasa dari input manual. Bar = porsi dari omzet." />
        {!d.rows.length ? <EmptyState icon={<Package size={20} />} title="Belum ada penjualan di periode ini" /> : (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead><tr className="text-[12px] text-muted">
                <th className="pb-3 pr-3 text-left font-medium">Produk / jasa</th><th className="px-3 pb-3 text-right font-medium">Harga</th>
                <th className="px-3 pb-3 text-right font-medium">Terjual</th><th className="px-3 pb-3 text-right font-medium">Omzet</th>
                <th className="px-3 pb-3 text-right font-medium">HPP</th><th className="w-[140px] pb-3 pl-3 text-left font-medium">Porsi</th>
              </tr></thead>
              <tbody className="divide-y divide-line">
                {d.rows.map((p) => (
                  <tr key={p.key}>
                    <td className="py-3 pr-3">
                      {p.url ? <a href={p.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium hover:text-accent">{p.name}<ExternalLink size={12} className="text-muted" /></a> : <span className="font-medium">{p.name}</span>}
                      <span className="block text-[11.5px] text-muted">{LINES[p.line].label} · {LINES[p.line].src}</span>
                    </td>
                    <td className="num px-3 py-3 text-right">{rpk(p.price)}</td>
                    <td className="num px-3 py-3 text-right">{nf(p.qty)}</td>
                    <td className="num px-3 py-3 text-right font-semibold">{rpk(p.revenue)}</td>
                    <td className="num px-3 py-3 text-right text-muted">{p.cogs ? rpk(p.cogs) : "—"}</td>
                    <td className="py-3 pl-3">
                      <div className="num text-[12px]">{pct(p.share)}</div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-track"><div className="h-full rounded-full" style={{ width: `${(p.revenue / max) * 100}%`, background: colors[p.line] }} /></div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="font-semibold"><td className="pt-3">Total</td><td /><td className="num px-3 pt-3 text-right">{nf(d.total.qty)}</td><td className="num px-3 pt-3 text-right">{rpk(d.total.revenue)}</td><td className="num px-3 pt-3 text-right">{d.total.cogs ? rpk(d.total.cogs) : "—"}</td><td /></tr></tfoot>
            </table>
          </div>
        )}
      </Card>
      <Card className="flex flex-col">
        <CardHead title="Porsi per lini" hint="Dari omzet periode ini" />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-2">
          <Donut size={150} thickness={24} parts={byLine.map((x) => ({ value: x.revenue, color: colors[x.line], label: LINES[x.line].label }))}
            center={<div><p className="text-[11px] text-muted">Omzet</p><p className="num text-[15px] font-semibold">{rpk(d.total.revenue)}</p></div>} />
          <Legend items={byLine.map((x) => ({ color: colors[x.line], label: <>{LINES[x.line].label} · <b className="num text-ink">{rpk(x.revenue)}</b></> }))} />
        </div>
      </Card>
    </div>
  );
}
