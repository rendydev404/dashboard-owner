import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Check, Sun, Moon, Layers } from "lucide-react";
import {
  PRESETS, PRESET_LABELS, fmtRange, shiftRange, compareRange, LINES, type Account, type Preset, type RangePreset,
} from "@iklan/shared";
import { setView, useView, getToday } from "../lib/view";
import { cx, useMediaQuery } from "./ui";

/** Popover di desktop, bottom sheet di HP. */
function Popover({ open, onClose, anchor, children, align = "left", width = 320 }: {
  open: boolean; onClose: () => void; anchor: React.RefObject<HTMLElement>; children: ReactNode; align?: "left" | "right"; width?: number;
}) {
  const mobile = useMediaQuery("(max-width: 767px)");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open, onClose, anchor]);
  if (!open) return null;
  if (mobile)
    return (
      <div className="fixed inset-0 z-[60] flex items-end bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div ref={ref} className="pop-in max-h-[85vh] w-full overflow-y-auto rounded-t-2xl bg-card p-4 pb-[max(16px,env(safe-area-inset-bottom))] shadow-pop">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong" />
          {children}
        </div>
      </div>
    );
  return (
    <div ref={ref} className={cx("pop-in absolute top-full z-50 mt-2 rounded-2xl border border-line bg-card p-3 shadow-pop", align === "right" ? "right-0" : "left-0")} style={{ width }}>
      {children}
    </div>
  );
}

/** Form rentang tanggal custom (dipakai dropdown periode & filter cepat). */
function CustomRange({ onDone }: { onDone: () => void }) {
  const v = useView();
  const today = getToday();
  const [cf, setCf] = useState(v.from), [ct, setCt] = useState(v.to);
  useEffect(() => { setCf(v.from); setCt(v.to); }, [v.from, v.to]);
  return (
    <>
      <div className="flex items-center gap-2">
        <input type="date" className="input min-h-[38px] px-2 text-[13px]" value={cf} max={today} onChange={(e) => setCf(e.target.value)} aria-label="Tanggal mulai" />
        <span className="text-muted">–</span>
        <input type="date" className="input min-h-[38px] px-2 text-[13px]" value={ct} max={today} onChange={(e) => setCt(e.target.value)} aria-label="Tanggal akhir" />
      </div>
      <button className="btn btn-primary mt-2 w-full" disabled={!cf || !ct} onClick={() => { setView({ preset: "custom", from: cf, to: ct }); onDone(); }}>Terapkan</button>
    </>
  );
}

export function PeriodPicker({ compact }: { compact?: boolean }) {
  const v = useView();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const today = getToday();
  const [pf, pt] = v.from ? compareRange(v.from, v.to) : ["", ""];
  const shift = (dir: 1 | -1) => {
    const [s, e] = shiftRange(v.from, v.to, dir, today);
    if (s <= today) setView({ preset: "custom", from: s, to: e });
  };
  const choose = (p: RangePreset) => { setView({ preset: p }); setOpen(false); };

  return (
    <div className="flex items-center gap-1">
      <button className="btn btn-ghost size-9 p-0" onClick={() => shift(-1)} aria-label="Periode sebelumnya"><ChevronLeft size={18} /></button>
      <div className="relative">
        <button ref={anchor} onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open}
          className="flex h-9 items-center gap-2 rounded-full border border-line bg-card px-3 text-[13px] font-medium hover:border-line-strong">
          <CalendarDays size={15} className="text-muted" />
          <span className="num whitespace-nowrap">{!v.from ? "…" : compact && v.preset !== "custom" ? PRESET_LABELS[v.preset] : fmtRange(v.from, v.to)}</span>
          <ChevronDown size={14} className="text-muted" />
        </button>
        <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={340}>
          <p className="label mb-2 px-1">Periode</p>
          <div className="grid grid-cols-2 gap-1">
            {PRESETS.map((p) => (
              <button key={p} onClick={() => choose(p)}
                className={cx("flex items-center justify-between rounded-lg px-3 py-2.5 text-left text-[13.5px] hover:bg-hover", v.preset === p && "bg-accent-soft font-semibold text-accent")}>
                {PRESET_LABELS[p]} {v.preset === p && <Check size={15} />}
              </button>
            ))}
          </div>
          <div className="mt-3 border-t border-line pt-3">
            <p className="label mb-2 px-1">Custom</p>
            <CustomRange onDone={() => setOpen(false)} />
          </div>
          {v.from && <p className="mt-3 px-1 text-[12px] text-muted">Dibanding {fmtRange(pf, pt)}</p>}
        </Popover>
      </div>
      <button className="btn btn-ghost size-9 p-0" onClick={() => shift(1)} disabled={!v.to || v.to >= today} aria-label="Periode berikutnya"><ChevronRight size={18} /></button>
    </div>
  );
}

export function accLabel(acc: string, accounts: Account[]) {
  if (acc === "all") return "Semua akun";
  if (acc === "digital") return "Akun Produk Digital";
  if (acc === "jasa") return "Akun Jasa";
  return accounts.find((a) => a.id === acc)?.name ?? "Akun";
}

const QUICK: { p: Preset; label: string }[] = [
  { p: "today", label: "Hari ini" }, { p: "yesterday", label: "Kemarin" }, { p: "7d", label: "7 hari" },
  { p: "thismonth", label: "Bulan ini" }, { p: "30d", label: "30 hari" },
];

function Chip({ on, onClick, children, title, ...rest }: { on: boolean; onClick: () => void; children: ReactNode; title?: string } & React.AriaAttributes) {
  return (
    <button onClick={onClick} title={title} aria-pressed={on} {...rest}
      className={cx("h-8 max-w-[220px] shrink-0 truncate rounded-full border px-3 text-[13px] transition-colors",
        on ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line bg-card text-ink hover:border-line-strong")}>
      {children}
    </button>
  );
}

/** Filter cepat yang selalu terlihat: periode umum + custom, dan pilihan akun. */
export function QuickFilters({ accounts }: { accounts: Account[] }) {
  const v = useView();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const active = accounts.filter((a) => a.active);
  const lines = (["digital", "jasa"] as const).filter((l) => active.filter((a) => a.line === l).length > 1);
  return (
    <div className="no-print flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-6">
      <div ref={anchor} className="relative flex min-w-0 items-center gap-1.5 overflow-x-auto scrollbar-none" role="group" aria-label="Periode">
        {QUICK.map(({ p, label }) => <Chip key={p} on={v.preset === p} onClick={() => setView({ preset: p })}>{label}</Chip>)}
        <Chip on={v.preset === "custom" || open} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {v.preset === "custom" ? fmtRange(v.from, v.to) : "Custom"}
        </Chip>
        <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="right" width={320}>
          <p className="label mb-2 px-1">Rentang custom</p>
          <CustomRange onDone={() => setOpen(false)} />
        </Popover>
      </div>
      {active.length > 0 && (
        <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto scrollbar-none" role="group" aria-label="Akun iklan">
          <Chip on={v.acc === "all"} onClick={() => setView({ acc: "all" })}>Semua akun</Chip>
          {lines.map((l) => <Chip key={l} on={v.acc === l} onClick={() => setView({ acc: l })}>{accLabel(l, accounts)}</Chip>)}
          {active.map((a) => <Chip key={a.id} on={v.acc === a.id} onClick={() => setView({ acc: a.id })} title={`${a.name} · ${LINES[a.line].label}`}>{a.name}</Chip>)}
        </div>
      )}
    </div>
  );
}

/** Toggle tema: matahari & bulan di dalam track, knob bergeser (seperti referensi). */
export function ThemeToggle() {
  const sysDark = useMediaQuery("(prefers-color-scheme: dark)");
  const [theme, setTheme] = useState<string | undefined>(document.documentElement.dataset.theme);
  const dark = theme ? theme === "dark" : sysDark;
  const toggle = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("iklan-theme", next); } catch { /* abaikan */ }
    setTheme(next);
  };
  return (
    <button onClick={toggle} role="switch" aria-checked={dark} aria-label={dark ? "Tema gelap aktif, ganti ke terang" : "Tema terang aktif, ganti ke gelap"}
      className="relative inline-flex h-8 w-[60px] shrink-0 items-center rounded-full border border-line-strong bg-track p-0.5 transition-colors hover:border-muted-2">
      <Sun size={14} className={cx("absolute left-2.5 transition-opacity", dark ? "text-muted opacity-70" : "opacity-0")} aria-hidden />
      <Moon size={14} className={cx("absolute right-2.5 transition-opacity", dark ? "opacity-0" : "text-muted opacity-70")} aria-hidden />
      <span className={cx("relative z-10 grid size-6 place-items-center rounded-full bg-card text-accent shadow-[0_1px_3px_rgba(0,0,0,.25)] transition-transform duration-200", dark ? "translate-x-[28px]" : "translate-x-0")}>
        {dark ? <Moon size={13} /> : <Sun size={13} />}
      </span>
    </button>
  );
}
