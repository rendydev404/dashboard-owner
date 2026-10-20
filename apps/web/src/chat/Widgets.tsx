import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight, ChevronDown } from "lucide-react";
import { rp, rpk, dec, pct, nf, type ChatWidget, type WidgetFormat, type WidgetTone } from "@iklan/shared";
import { cx } from "../components/ui";

const fmt = (v: number | null | undefined, f: WidgetFormat, full = false) =>
  v == null || !Number.isFinite(v) ? "—" : f === "rp" ? (full ? rp(v) : rpk(v)) : f === "x" ? `${dec(v)}x` : f === "pct" ? pct(v) : nf(v);

const TONE_BAR: Record<WidgetTone, string> = { good: "bg-green", bad: "bg-red", warn: "bg-yellow", neutral: "bg-accent" };
const TONE_TEXT: Record<WidgetTone, string> = { good: "text-green-ink", bad: "text-red-ink", warn: "text-yellow-ink", neutral: "text-muted" };

/** Animasi masuk: lebar bar/progress tumbuh dari 0 setelah widget tampil. */
function useGrow() {
  const [on, setOn] = useState(false);
  useEffect(() => { const t = requestAnimationFrame(() => setOn(true)); return () => cancelAnimationFrame(t); }, []);
  return on;
}

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="chat-widget rounded-2xl border border-line bg-card p-3.5">
      <header className="mb-2.5">
        <p className="text-[13px] font-semibold leading-tight">{title}</p>
        {subtitle && <p className="mt-0.5 text-[11.5px] text-muted">{subtitle}</p>}
      </header>
      {children}
    </section>
  );
}

function Delta({ value, prev, upIsGood = true }: { value: number | null; prev?: number | null; upIsGood?: boolean }) {
  if (value == null || prev == null || !Number.isFinite(prev)) return <span className="text-[11px] text-muted">belum ada pembanding</span>;
  if (prev === 0) return value === 0 ? <span className="text-[11px] text-muted">sama</span> : <span className="text-[11px] text-muted">baru</span>;
  const d = (value - prev) / Math.abs(prev);
  const up = d >= 0, good = up === upIsGood || Math.abs(d) < 0.005;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cx("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold", good ? "bg-green-soft text-green-ink" : "bg-red-soft text-red-ink")}>
      <Icon size={12} />{dec(Math.abs(d) * 100, 1)}%
    </span>
  );
}

function Kpis({ w }: { w: Extract<ChatWidget, { kind: "kpis" }> }) {
  return (
    <Shell title={w.title} subtitle={w.subtitle}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {w.items.map((it) => (
          <div key={it.label} className="rounded-xl bg-bg px-3 py-2.5" title={`${it.label}: ${fmt(it.value, it.format, true)}${it.prev != null ? ` · sebelumnya ${fmt(it.prev, it.format, true)}` : ""}`}>
            <p className="truncate text-[11.5px] text-muted">{it.label}</p>
            <p className={cx("num mt-0.5 text-[17px] font-semibold leading-tight", it.format === "rp" && (it.value ?? 0) < 0 && "text-red-ink")}>{fmt(it.value, it.format)}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Delta value={it.value} prev={it.prev} upIsGood={it.upIsGood} />
              {it.hint && <span className="truncate text-[11px] text-muted">{it.hint}</span>}
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}

function Progress({ w }: { w: Extract<ChatWidget, { kind: "progress" }> }) {
  const grow = useGrow();
  return (
    <Shell title={w.title} subtitle={w.subtitle}>
      <div className="space-y-3">
        {w.items.map((it) => {
          const ratio = it.target > 0 ? it.value / it.target : 0;
          const tone: WidgetTone = ratio >= 1.3 ? "good" : ratio >= 1 ? "neutral" : ratio >= 0.8 ? "warn" : "bad";
          return (
            <div key={it.label}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-[12.5px]">
                <span className="font-medium">{it.label}</span>
                <span className="num"><b>{fmt(it.value, it.format)}</b> <span className="text-muted">/ {fmt(it.target, it.format)}</span></span>
              </div>
              <div className="relative h-2.5 overflow-hidden rounded-full bg-track" role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={150} aria-label={it.label}>
                <div className={cx("h-full rounded-full transition-[width] duration-700 ease-out", TONE_BAR[tone])} style={{ width: grow ? `${Math.min(ratio / 1.5, 1) * 100}%` : 0 }} />
                <div className="absolute inset-y-0 w-0.5 bg-ink/60" style={{ left: `${(1 / 1.5) * 100}%` }} title="Target" />
              </div>
              <p className={cx("mt-1 text-[11.5px] font-medium", TONE_TEXT[tone])}>{dec(ratio * 100, 0)}% dari target{it.hint ? ` · ${it.hint}` : ""}</p>
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

function Bars({ w }: { w: Extract<ChatWidget, { kind: "bars" }> }) {
  const grow = useGrow();
  const [all, setAll] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(...w.items.map((x) => Math.abs(x.value)), 1);
  const shown = all ? w.items : w.items.slice(0, 5);
  return (
    <Shell title={w.title} subtitle={w.subtitle}>
      <ul className="space-y-2">
        {shown.map((it, i) => (
          <li key={it.label + i}>
            <button type="button" onClick={() => setActive(active === i ? null : i)} className="w-full text-left" aria-expanded={active === i}>
              <div className="mb-1 flex items-baseline justify-between gap-3 text-[12.5px]">
                <span className="min-w-0 truncate font-medium" title={it.label}>{it.label}</span>
                <span className="num shrink-0 font-semibold">{fmt(it.value, w.format)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-track">
                <div className={cx("h-full rounded-full transition-[width] duration-700 ease-out", TONE_BAR[it.tone ?? "neutral"])} style={{ width: grow ? `${(Math.abs(it.value) / max) * 100}%`: 0, transitionDelay: `${i * 60}ms` }} />
              </div>
              {it.sub && <p className={cx("mt-0.5 truncate text-[11.5px]", active === i ? "whitespace-normal" : "", TONE_TEXT[it.tone ?? "neutral"])}>{it.sub}{active === i ? ` · ${fmt(it.value, w.format, true)}` : ""}</p>}
            </button>
          </li>
        ))}
      </ul>
      {w.items.length > 5 && (
        <button type="button" onClick={() => setAll((x) => !x)} className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-accent">
          {all ? "Tampilkan lebih sedikit" : `Lihat semua (${w.items.length})`} <ChevronDown size={14} className={cx("transition-transform", all && "rotate-180")} />
        </button>
      )}
    </Shell>
  );
}

export function Widget({ w }: { w: ChatWidget }) {
  return w.kind === "kpis" ? <Kpis w={w} /> : w.kind === "progress" ? <Progress w={w} /> : <Bars w={w} />;
}
