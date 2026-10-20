// Grafik. Donut & ring = SVG murni (tanpa library). Bar/garis = Chart.js yang dimuat lazy saat pertama dibutuhkan.
import { useEffect, useRef, useState } from "react";
import type { Chart as ChartT, ChartConfiguration } from "chart.js";
import { shortNum } from "@iklan/shared";

let chartMod: Promise<typeof import("./chart-setup")> | null = null;
const loadChart = () => (chartMod ??= import("./chart-setup"));

const cssv = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/** Re-render grafik saat tema berganti. */
function useThemeKey() {
  const [k, setK] = useState(0);
  useEffect(() => {
    const obs = new MutationObserver(() => setK((x) => x + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setK((x) => x + 1);
    mq.addEventListener("change", on);
    return () => { obs.disconnect(); mq.removeEventListener("change", on); };
  }, []);
  return k;
}

export function ChartCanvas({ build, height = 280, label }: { build: (c: typeof cssv) => ChartConfiguration; height?: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chart = useRef<ChartT | null>(null);
  const themeKey = useThemeKey();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    loadChart().then(({ Chart }) => {
      if (!alive || !ref.current) return;
      const cfg = build(cssv);
      if (chart.current && (chart.current.config as any).type === (cfg as any).type) {
        chart.current.data = cfg.data;
        chart.current.options = cfg.options!;
        chart.current.update();
      } else {
        chart.current?.destroy();
        chart.current = new Chart(ref.current, cfg);
      }
      setReady(true);
    });
    return () => { alive = false; };
  }, [build, themeKey]);
  useEffect(() => () => chart.current?.destroy(), []);
  return (
    <div className="relative" style={{ height }}>
      {!ready && <div className="skeleton absolute inset-0" />}
      <canvas ref={ref} role="img" aria-label={label} />
    </div>
  );
}

export const axisMoney = (v: number | string) => shortNum(Number(v));

/** Opsi dasar Chart.js sesuai gaya referensi (grid tipis, legenda bulat kecil). */
export function baseOptions(c: typeof cssv): any {
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { position: "bottom", labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: "circle", color: c("--muted"), padding: 16, font: { size: 12 } } },
      tooltip: { backgroundColor: c("--ink"), titleColor: c("--bg"), bodyColor: c("--bg"), padding: 10, cornerRadius: 10, boxPadding: 4, usePointStyle: true },
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: c("--muted"), font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 } },
      y: { grid: { color: c("--line") }, border: { display: false }, beginAtZero: true, ticks: { color: c("--muted"), font: { size: 11 }, callback: axisMoney, maxTicksLimit: 5 } },
    },
  };
}

/* ------------------------------------------------------------------ SVG */

export function Donut({ parts, size = 132, thickness = 22, center }: { parts: { value: number; color: string; label: string }[]; size?: number; thickness?: number; center?: React.ReactNode }) {
  const total = parts.reduce((t, p) => t + Math.max(0, p.value), 0);
  const r = (size - thickness) / 2, C = 2 * Math.PI * r;
  let off = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={parts.map((p) => `${p.label} ${total ? Math.round((p.value / total) * 100) : 0}%`).join(", ")}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={thickness} />
        {total > 0 && parts.map((p, i) => {
          const len = (Math.max(0, p.value) / total) * C;
          const gap = parts.filter((x) => x.value > 0).length > 1 ? Math.min(4, len / 3) : 0;
          const el = (
            <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={p.color} strokeWidth={thickness}
              strokeDasharray={`${Math.max(0, len - gap)} ${C}`} strokeDashoffset={-off} transform={`rotate(-90 ${size / 2} ${size / 2})`} strokeLinecap="butt" />
          );
          off += len;
          return el;
        })}
      </svg>
      {center && <div className="absolute inset-0 grid place-items-center text-center">{center}</div>}
    </div>
  );
}

export function Ring({ value, color, size = 48, stroke = 4.5, children }: { value: number; color: string; size?: number; stroke?: number; children?: React.ReactNode }) {
  const r = (size - stroke) / 2, C = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${v * C} ${C}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-[10.5px] font-semibold num">{children}</div>
    </div>
  );
}

export function Legend({ items }: { items: { color: string; label: React.ReactNode }[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex items-center gap-2 text-[12px] text-muted">
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: it.color }} />
          <span className="min-w-0">{it.label}</span>
        </li>
      ))}
    </ul>
  );
}
