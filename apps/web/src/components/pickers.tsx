import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Check, Sun, Moon, Layers } from "lucide-react";
import {
  PRESETS, PRESET_LABELS, fmtRange, shiftRange, compareRange, LINES, type Account, type RangePreset,
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

export function PeriodPicker({ compact }: { compact?: boolean }) {
  const v = useView();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const today = getToday();
  const [cf, setCf] = useState(v.from), [ct, setCt] = useState(v.to);
  useEffect(() => { setCf(v.from); setCt(v.to); }, [v.from, v.to]);
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
            <div className="flex items-center gap-2">
              <input type="date" className="input min-h-[38px] px-2 text-[13px]" value={cf} max={today} onChange={(e) => setCf(e.target.value)} aria-label="Tanggal mulai" />
              <span className="text-muted">–</span>
              <input type="date" className="input min-h-[38px] px-2 text-[13px]" value={ct} max={today} onChange={(e) => setCt(e.target.value)} aria-label="Tanggal akhir" />
            </div>
            <button className="btn btn-primary mt-2 w-full" disabled={!cf || !ct} onClick={() => { setView({ preset: "custom", from: cf, to: ct }); setOpen(false); }}>Terapkan</button>
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

export function AccountPicker({ accounts }: { accounts: Account[] }) {
  const v = useView();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const active = accounts.filter((a) => a.active);
  const groups: { id: string; label: string; sub: string }[] = [{ id: "all", label: "Semua akun", sub: "Gabungan semua lini" }];
  const byLine = (l: "digital" | "jasa") => active.filter((a) => a.line === l);
  if (byLine("digital").length) groups.push({ id: "digital", label: "Akun Produk Digital", sub: `${byLine("digital").length} akun · omzet lynk.id` });
  if (byLine("jasa").length) groups.push({ id: "jasa", label: "Akun Jasa", sub: `${byLine("jasa").length} akun · leads & closing` });
  const item = (id: string, label: string, sub: string) => (
    <button key={id} onClick={() => { setView({ acc: id }); setOpen(false); }}
      className={cx("flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-hover", v.acc === id && "bg-accent-soft")}>
      <span className="min-w-0">
        <span className={cx("block truncate text-[13.5px]", v.acc === id && "font-semibold text-accent")}>{label}</span>
        <span className="block truncate text-[12px] text-muted">{sub}</span>
      </span>
      {v.acc === id && <Check size={15} className="shrink-0 text-accent" />}
    </button>
  );
  return (
    <div className="relative">
      <button ref={anchor} onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open}
        className="flex h-9 max-w-[220px] items-center gap-2 rounded-full border border-line bg-card px-3 text-[13px] font-medium hover:border-line-strong">
        <Layers size={15} className="shrink-0 text-muted" />
        <span className="truncate">{accLabel(v.acc, accounts)}</span>
        <ChevronDown size={14} className="shrink-0 text-muted" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={300}>
        <p className="label mb-1 px-1">Tampilan</p>
        {groups.map((g) => item(g.id, g.label, g.sub))}
        {active.length > 1 && <p className="label mb-1 mt-3 px-1">Per akun</p>}
        {active.length > 1 && active.map((a) => item(a.id, a.name, LINES[a.line].label))}
      </Popover>
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
