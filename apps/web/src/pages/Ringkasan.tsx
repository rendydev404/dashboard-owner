import { useCallback } from "react";
import { Wallet, Receipt, Megaphone, Target, Users, MousePointerClick, BadgeDollarSign, Percent, ShoppingBag, TrendingUp, Sparkles } from "lucide-react";
import { rpk, rp, dec, pct, nf, LINES, type DashboardResp } from "@iklan/shared";
import { useDashboard } from "../lib/api";
import { Card, CardHead, ErrorState, Skeleton, cx } from "../components/ui";
import { KpiCard, KpiSkeleton } from "../components/kpi";
import { ChartCanvas, Donut, Ring, Legend, baseOptions } from "../components/charts";

function kpiList(d: DashboardResp) {
  const k = d.kpis, p = d.prev, { hasLeads, hasDigital } = d.scope;
  const onlyJasa = hasLeads && !hasDigital;
  const ic = 16;
  return [
    { label: "Laba bersih", value: rpk(k.net), sub: `margin bersih ${pct(k.netMargin)}`, cur: k.net, prev: p.net, goodUp: true, highlight: true, tone: k.net >= 0 ? "pos" : "neg", icon: <Wallet size={ic} /> },
    { label: "Omzet riil", value: rpk(k.revenue), sub: `${nf(k.orders)} ${onlyJasa ? "closing" : "order"}`, cur: k.revenue, prev: p.revenue, goodUp: true, icon: <Receipt size={ic} /> },
    { label: "Spend iklan", value: rpk(k.spend), sub: `+ PPN ${rpk(k.adTax)}`, cur: k.spend, prev: p.spend, goodUp: null, icon: <Megaphone size={ic} /> },
    { label: "ROAS riil", value: `${dec(k.roas)}x`, sub: `impas di ${dec(k.beRoas)}x`, cur: k.roas, prev: p.roas, goodUp: true, tone: k.spend ? (k.roas >= k.beRoas ? "pos" : "neg") : undefined, icon: <Target size={ic} /> },
    hasLeads
      ? { label: "Leads", value: nf(k.leads), sub: `closing rate ${pct(k.closeRate)}`, cur: k.leads, prev: p.leads, goodUp: true, icon: <Users size={ic} /> }
      : { label: "AOV", value: rpk(k.aov), sub: "rata-rata per order", cur: k.aov, prev: p.aov, goodUp: true, icon: <ShoppingBag size={ic} /> },
    hasLeads
      ? { label: "CPL", value: rpk(k.cpl), sub: "biaya per lead", cur: k.cpl, prev: p.cpl, goodUp: false, icon: <BadgeDollarSign size={ic} /> }
      : { label: "CTR", value: pct(k.ctr), sub: `${nf(k.clicks)} klik`, cur: k.ctr, prev: p.ctr, goodUp: true, icon: <MousePointerClick size={ic} /> },
    { label: "CPA", value: rpk(k.cpa), sub: `maks. impas ${rpk(k.maxCpaBE)}`, cur: k.cpa, prev: p.cpa, goodUp: false, tone: k.orders ? (k.cpa <= k.maxCpaBE ? "pos" : "neg") : undefined, icon: <Percent size={ic} /> },
    hasLeads && hasDigital
      ? { label: "CTR", value: pct(k.ctr), sub: `${nf(k.clicks)} klik`, cur: k.ctr, prev: p.ctr, goodUp: true, icon: <MousePointerClick size={ic} /> }
      : { label: "CPC", value: rpk(k.cpc), sub: `${nf(k.impr)} impresi`, cur: k.cpc, prev: p.cpc, goodUp: false, icon: <MousePointerClick size={ic} /> },
  ] as const;
}

const INSIGHT_ROW: Record<string, string> = { good: "row-green", bad: "row-red", warn: "row-yellow", info: "bg-bg" };
const INSIGHT_DOT: Record<string, string> = { good: "bg-green", bad: "bg-red", warn: "bg-yellow", info: "bg-accent" };

export default function Ringkasan() {
  const { data: d, error, isLoading, refetch, isPlaceholderData } = useDashboard();

  const trend = useCallback((c: (v: string) => string) => {
    const pts = d!.series.points, hour = d!.series.granularity === "hour";
    const base = baseOptions(c);
    return {
      type: "bar" as const,
      data: {
        labels: pts.map((x) => x.label),
        datasets: [
          { type: "bar" as const, label: "Spend", data: pts.map((x) => x.spend), backgroundColor: c("--accent"), borderRadius: 99, borderSkipped: false, barPercentage: 0.55, categoryPercentage: 0.7, maxBarThickness: 10, order: 2 },
          { type: "bar" as const, label: "Omzet riil", data: pts.map((x) => x.revenue), backgroundColor: c("--yellow"), borderRadius: 99, borderSkipped: false, barPercentage: 0.55, categoryPercentage: 0.7, maxBarThickness: 10, order: 3 },
          { type: "line" as const, label: "ROAS riil", data: pts.map((x) => x.roas), borderColor: c("--violet-a"), backgroundColor: c("--violet-a"), yAxisID: "y2", tension: 0.4, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.2, order: 1 },
        ],
      },
      options: {
        ...base,
        plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: { label: (t: any) => `${t.dataset.label}: ${t.dataset.yAxisID === "y2" ? dec(t.raw) + "x" : rp(t.raw)}` } } },
        scales: { ...base.scales, x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxTicksLimit: hour ? 12 : 10 } }, y2: { position: "right", beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { color: c("--muted"), font: { size: 11 }, callback: (v: number) => dec(v, 1) + "x", maxTicksLimit: 5 } } },
      },
    } as any;
  }, [d]);

  const results = useCallback((c: (v: string) => string) => {
    const pts = d!.series.points;
    const ctx = document.createElement("canvas").getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 0, 240);
    g.addColorStop(0, "rgba(168,85,247,.28)"); g.addColorStop(1, "rgba(124,58,237,0)");
    const lead = d!.scope.hasLeads && !d!.scope.hasDigital;
    return {
      type: "line" as const,
      data: {
        labels: pts.map((x) => x.label),
        datasets: [{ label: lead ? "Leads" : "Pembelian (Meta)", data: pts.map((x) => (lead ? x.leads : x.results)), borderColor: c("--violet-b"), backgroundColor: g, fill: true, tension: 0.45, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.4 }],
      },
      options: { ...baseOptions(c), plugins: { ...baseOptions(c).plugins, legend: { display: false } }, scales: { ...baseOptions(c).scales, y: { ...baseOptions(c).scales.y, ticks: { ...baseOptions(c).scales.y.ticks, callback: (v: number) => nf(v), precision: 0 } } } },
    } as any;
  }, [d]);

  if (error && !d) return <Card><ErrorState error={error} onRetry={() => refetch()} /></Card>;
  if (isLoading || !d)
    return (
      <div className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => <KpiSkeleton key={i} />)}
        <div className="card col-span-2 h-[360px] p-5"><Skeleton className="h-full" /></div>
        <div className="card col-span-2 h-[360px] p-5"><Skeleton className="h-full" /></div>
      </div>
    );

  const k = d.kpis;
  const kp = kpiList(d);
  const lineColors = { digital: "var(--accent)", jasa: "var(--yellow)" } as const;
  const revTotal = d.revenueByLine.reduce((t, x) => t + x.revenue, 0);
  const roasRatio = d.targetRoas ? k.roas / d.targetRoas : 0;
  const netCh = d.prev.net ? (k.net - d.prev.net) / Math.abs(d.prev.net) : 0;
  const single = d.range.days === 1;

  return (
    <div className={cx("space-y-3 transition-opacity md:space-y-4", isPlaceholderData && "opacity-70")}>
      <div className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">
        <div className="col-span-2 grid grid-cols-2 gap-3 md:gap-4">
          {kp.slice(0, 4).map((x) => <KpiCard key={x.label} {...x} />)}
        </div>
        <Card className="col-span-2 flex flex-col sm:col-span-1">
          <CardHead title="Komposisi omzet" hint="Per lini bisnis" />
          <p className="num -mt-2 text-[26px] font-medium tracking-tight">{rpk(revTotal)}</p>
          <div className="mt-auto flex items-end justify-between gap-3 pt-4">
            <Legend items={d.revenueByLine.map((x) => ({ color: lineColors[x.line], label: <><b className="num font-semibold text-ink">{revTotal ? Math.round((x.revenue / revTotal) * 100) : 0}%</b> {LINES[x.line].label}</> }))} />
            <Donut size={112} thickness={20} parts={d.revenueByLine.map((x) => ({ value: x.revenue, color: lineColors[x.line], label: LINES[x.line].label }))} />
          </div>
        </Card>
        <Card className="col-span-2 flex flex-col sm:col-span-1">
          <CardHead title="Status kampanye" hint="Akun terpilih" />
          <p className="num -mt-2 text-[26px] font-medium tracking-tight">{nf(d.campaignStatus.active + d.campaignStatus.paused)}</p>
          <div className="mt-auto flex items-end justify-between gap-3 pt-4">
            <Legend items={[
              { color: "var(--accent)", label: <><b className="num font-semibold text-ink">{d.campaignStatus.active}</b> Aktif</> },
              { color: "var(--muted-2)", label: <><b className="num font-semibold text-ink">{d.campaignStatus.paused}</b> Jeda</> },
            ]} />
            <Donut size={112} thickness={20} parts={[{ value: d.campaignStatus.active, color: "var(--accent)", label: "Aktif" }, { value: d.campaignStatus.paused, color: "var(--muted-2)", label: "Jeda" }]} />
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">
        {kp.slice(4).map((x) => <KpiCard key={x.label} {...x} />)}
      </div>

      <div className="grid gap-3 md:gap-4 xl:grid-cols-4">
        <div className="space-y-3 md:space-y-4 xl:col-span-2">
          <Card>
            <CardHead title={single ? "Tren per jam" : "Tren harian"} hint={single ? "Periode 1 hari: spend vs omzet per jam" : "Spend iklan vs omzet riil, garis = ROAS riil"} />
            <ChartCanvas build={trend} height={270} label="Grafik spend, omzet dan ROAS" />
          </Card>
          <Card>
            <CardHead title={d.scope.hasLeads && !d.scope.hasDigital ? "Aktivitas leads" : "Aktivitas pembelian"} hint="Hasil dari Meta per hari/jam" />
            <ChartCanvas build={results} height={200} label="Grafik hasil iklan" />
          </Card>
        </div>
        <div className="space-y-3 md:space-y-4 xl:col-span-2">
          <div className="grid grid-cols-2 gap-3 md:gap-4">
            <Card className="flex flex-col">
              <div className="flex items-start justify-between">
                <span className="grid size-10 place-items-center rounded-xl border border-line"><Target size={19} /></span>
                <Ring value={roasRatio} color={roasRatio >= 1 ? "var(--green)" : "var(--pink)"}>{Math.round(roasRatio * 100)}%</Ring>
              </div>
              <p className="mt-4 text-[13px] text-muted">ROAS riil vs target</p>
              <p className="num text-[22px] font-medium tracking-tight md:text-[26px]">{dec(k.roas)}x <span className="text-[14px] text-muted">/ {dec(d.targetRoas, 1)}x</span></p>
              <p className="mt-1 text-[12px] text-muted">{roasRatio >= 1 ? "Di atas target" : "Di bawah target"}</p>
            </Card>
            <Card className="flex flex-col">
              <div className="flex items-start justify-between">
                <span className="grid size-10 place-items-center rounded-xl border border-line"><TrendingUp size={19} /></span>
                <Ring value={Math.min(1, Math.abs(netCh))} color={netCh >= 0 ? "var(--green)" : "var(--red)"}>{netCh >= 0 ? "+" : "−"}{Math.min(999, Math.round(Math.abs(netCh) * 100))}%</Ring>
              </div>
              <p className="mt-4 text-[13px] text-muted">Laba vs periode lalu</p>
              <p className={cx("num text-[22px] font-medium tracking-tight md:text-[26px]", k.net >= 0 ? "text-green-ink" : "text-red-ink")}>{rpk(k.net)}</p>
              <p className="mt-1 truncate text-[12px] text-muted">Sebelumnya {rpk(d.prev.net)}</p>
            </Card>
          </div>
          <Card>
            <CardHead title={<span className="inline-flex items-center gap-2"><Sparkles size={16} className="text-accent" /> Insight bot</span>} hint="Dibaca otomatis dari periode yang dipilih" />
            <ul className="space-y-2">
              {d.insights.map((x, i) => (
                <li key={i} className={cx("flex gap-3 rounded-xl px-4 py-3", INSIGHT_ROW[x.tone])}>
                  <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", INSIGHT_DOT[x.tone])} />
                  <div className="min-w-0 text-[13.5px]"><p className="font-semibold">{x.title}</p><p className="text-ink/75">{x.text}</p></div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
