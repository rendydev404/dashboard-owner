import { useCallback } from "react";
import { rp, rpk, nf, type HourRow } from "@iklan/shared";
import { useHourly } from "../lib/api";
import { Card, CardHead, EmptyState, ErrorState, Skeleton, cx } from "../components/ui";
import { ChartCanvas, baseOptions } from "../components/charts";

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

function HourTable({ rows, label, tone }: { rows: HourRow[]; label: string; tone: "green" | "red" }) {
  if (!rows.length) return <EmptyState title="Belum ada data" />;
  return (
    <table className="w-full border-separate border-spacing-y-1.5 text-[13px]">
      <thead><tr className="text-[12px] text-muted">
        <th className="px-3 pb-1 text-left font-medium">Jam</th><th className="px-3 pb-1 text-right font-medium">Spend</th>
        <th className="px-3 pb-1 text-right font-medium">{label}</th><th className="px-3 pb-1 text-right font-medium">Biaya/hasil</th>
      </tr></thead>
      <tbody>
        {rows.map((h, i) => (
          <tr key={h.hour} className={cx(i === 0 && (tone === "green" ? "row-green" : "row-red"))}>
            <td className="num rounded-l-xl px-3 py-2.5 font-semibold">{hh(h.hour)}</td>
            <td className="num px-3 py-2.5 text-right">{rpk(h.spend)}</td>
            <td className="num px-3 py-2.5 text-right">{nf(h.results)}</td>
            <td className="num rounded-r-xl px-3 py-2.5 text-right">{h.cost ? rpk(h.cost) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function PerJam() {
  const { data: d, error, isLoading, refetch, isPlaceholderData } = useHourly();
  const build = useCallback((c: (v: string) => string) => {
    const lbl = d!.metric === "leads" ? "Leads" : "Pembelian";
    const base = baseOptions(c);
    return {
      type: "bar",
      data: {
        labels: d!.hours.map((h) => String(h.hour).padStart(2, "0")),
        datasets: [
          { type: "bar", label: "Spend", data: d!.hours.map((h) => h.spend), backgroundColor: c("--accent"), borderRadius: 99, borderSkipped: false, maxBarThickness: 12, order: 2 },
          { type: "line", label: lbl, data: d!.hours.map((h) => h.results), borderColor: c("--violet-a"), backgroundColor: c("--violet-a"), yAxisID: "y2", tension: 0.4, pointRadius: 2, borderWidth: 2.2, order: 1 },
          ...(d!.hasLeads && d!.hasDigital ? [{ type: "line", label: "Leads", data: d!.hours.map((h) => h.leads), borderColor: c("--yellow"), backgroundColor: c("--yellow"), yAxisID: "y2", tension: 0.4, pointRadius: 2, borderWidth: 2, order: 1 }] : []),
        ],
      },
      options: {
        ...base,
        plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: { title: (t: any) => `Jam ${t[0].label}:00`, label: (t: any) => `${t.dataset.label}: ${t.dataset.yAxisID === "y2" ? nf(t.raw) : rp(t.raw)}` } } },
        scales: { ...base.scales, y2: { position: "right", beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { color: c("--muted"), precision: 0, font: { size: 11 } } } },
      },
    } as any;
  }, [d]);

  if (error && !d) return <Card><ErrorState error={error} onRetry={() => refetch()} /></Card>;
  if (isLoading || !d) return <Card><Skeleton className="h-[320px]" /></Card>;
  const lbl = d.metric === "leads" ? "Leads" : "Beli";
  return (
    <div className={cx("space-y-3 transition-opacity md:space-y-4", isPlaceholderData && "opacity-70")}>
      <Card>
        <CardHead title="Performa per jam" hint="Akumulasi per jam selama periode terpilih (zona waktu akun iklan). Bar = spend, garis = hasil." />
        <ChartCanvas build={build} height={320} label="Grafik spend dan hasil per jam" />
      </Card>
      <div className="grid gap-3 md:grid-cols-2 md:gap-4">
        <Card><CardHead title="Jam paling cuan" hint="Biaya per hasil terendah" /><HourTable rows={d.best} label={lbl} tone="green" /></Card>
        <Card><CardHead title="Jam paling boros" hint="Spend tanpa / sedikit hasil" /><HourTable rows={d.worst} label={lbl} tone="red" /></Card>
      </div>
    </div>
  );
}
