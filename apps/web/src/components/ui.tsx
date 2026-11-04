import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, CheckCircle2, Info, RotateCw, X, ArrowUp, ArrowDown, ChevronDown, Check } from "lucide-react";
import { dec } from "@iklan/shared";

export const cx = (...a: (string | false | 0 | null | undefined)[]) => a.filter(Boolean).join(" ");

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("card p-5", className)} {...rest}>{children}</div>;
}

export function CardHead({ title, hint, right }: { title: ReactNode; hint?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold leading-tight">{title}</h2>
        {hint && <p className="mt-1 text-[12.5px] text-muted">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

export const Skeleton = ({ className }: { className?: string }) => <div className={cx("skeleton", className)} aria-hidden />;

export function EmptyState({ title, text, icon }: { title: string; text?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <div className="grid size-11 place-items-center rounded-full bg-bg text-muted">{icon ?? <Info size={20} />}</div>
      <p className="font-semibold">{title}</p>
      {text && <p className="max-w-sm text-[13px] text-muted">{text}</p>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <div className="grid size-11 place-items-center rounded-full bg-red-soft text-red"><AlertCircle size={20} /></div>
      <p className="font-semibold">Gagal memuat data</p>
      <p className="text-[13px] text-muted">{error instanceof Error ? error.message : "Coba lagi sebentar."}</p>
      {onRetry && <button className="btn" onClick={onRetry}><RotateCw size={15} /> Coba lagi</button>}
    </div>
  );
}

/** Perubahan vs periode lalu. goodUp=true → naik itu bagus (hijau). */
export function Delta({ cur, prev, goodUp, className }: { cur: number; prev: number | null | undefined; goodUp: boolean | null; className?: string }) {
  if (!prev) return <span className={cx("text-[12px] text-muted", className)}>— belum ada pembanding</span>;
  const ch = (cur - prev) / Math.abs(prev);
  const up = ch >= 0;
  const tone = goodUp == null ? "text-muted" : up === goodUp ? "text-green-ink" : "text-red-ink";
  return (
    <span className={cx("inline-flex items-center gap-1 text-[12px] font-semibold", tone, className)}>
      {up ? <ArrowUp size={13} strokeWidth={2.5} /> : <ArrowDown size={13} strokeWidth={2.5} />}
      <span className="num">{dec(Math.abs(ch) * 100, 1)}%</span>
      <span className="hidden font-normal text-muted sm:inline">vs periode lalu</span>
    </span>
  );
}

/* ------------------------------------------------------------------ custom controls (tanpa kontrol native browser) */

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

export function CustomSelect<T extends string = string>({
  value,
  onChange,
  options,
  placeholder = "Pilih opsi",
  className,
  ariaLabel,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 220 });

  const selected = options.find((o) => o.value === value);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const updatePos = () => {
      const el = btnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const maxH = Math.min(options.length * 44 + 12, 280);
      const spaceBelow = window.innerHeight - r.bottom - 12;
      const top = spaceBelow < maxH && r.top > maxH ? Math.max(8, r.top - maxH - 6) : r.bottom + 6;
      setPos({ top, left: Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)), width: Math.max(r.width, 180) });
    };
    updatePos();
    window.addEventListener("resize", updatePos);
    window.addEventListener("scroll", updatePos, true);
    return () => {
      window.removeEventListener("resize", updatePos);
      window.removeEventListener("scroll", updatePos, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); btnRef.current?.focus(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) { setOpen(true); return; }
            const idx = Math.max(0, options.findIndex((o) => o.value === value));
            const next = options[(idx + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length];
            if (next) onChange(next.value);
          }
        }}
        className={cx(
          "input flex items-center justify-between gap-2 text-left transition-colors",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-muted-2",
          open && "border-accent",
          className,
        )}
      >
        <span className={cx("truncate text-[13.5px]", selected ? "text-ink" : "text-muted")}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={16} className={cx("shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          role="listbox"
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}
          className="pop-in z-[80] max-h-[280px] overflow-y-auto rounded-xl border border-line-strong bg-card p-1.5 shadow-pop"
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { onChange(opt.value); setOpen(false); btnRef.current?.focus(); }}
                className={cx(
                  "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors",
                  active ? "bg-accent-soft font-semibold text-accent" : "text-ink hover:bg-hover",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{opt.label}</span>
                  {opt.hint && <span className="block truncate text-[11.5px] font-normal text-muted">{opt.hint}</span>}
                </span>
                {active && <Check size={15} className="shrink-0 text-accent" />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

export function CustomSwitch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className={cx("flex items-center justify-between gap-3", disabled && "opacity-50")}>
      {(label || hint) && (
        <div className="min-w-0">
          {label && <p className="text-[13.5px] font-medium leading-snug text-ink">{label}</p>}
          {hint && <p className="text-[12px] text-muted">{hint}</p>}
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={cx(
          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors",
          checked ? "border-accent bg-accent" : "border-line-strong bg-track",
          disabled && "cursor-not-allowed",
        )}
      >
        <span
          className={cx(
            "inline-block size-4 rounded-full bg-card transition-transform",
            checked ? "translate-x-5" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ toast */

type ToastT = { id: number; text: string; tone: "ok" | "err" | "info"; action?: { label: string; run: () => void } };
let toasts: ToastT[] = [];
const toastSubs = new Set<() => void>();
const notify = () => toastSubs.forEach((f) => f());
let tid = 0;
export function toast(text: string, opts: { tone?: ToastT["tone"]; action?: ToastT["action"]; ms?: number } = {}) {
  const id = ++tid;
  toasts = [...toasts.slice(-3), { id, text, tone: opts.tone ?? "ok", action: opts.action }];
  notify();
  setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); notify(); }, opts.ms ?? 4500);
}
export function Toaster() {
  const list = useSyncExternalStore((f) => { toastSubs.add(f); return () => toastSubs.delete(f); }, () => toasts);
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[70] flex flex-col items-center gap-2 px-4 md:bottom-6" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="pop-in pointer-events-auto flex max-w-md items-center gap-3 rounded-xl bg-ink px-4 py-3 text-[13.5px] text-bg shadow-pop">
          {t.tone === "err" ? <AlertCircle size={17} className="shrink-0 text-red" /> : t.tone === "info" ? <Info size={17} className="shrink-0" /> : <CheckCircle2 size={17} className="shrink-0 text-green" />}
          <span>{t.text}</span>
          {t.action && (
            <button className="ml-1 font-semibold text-accent" onClick={() => { t.action!.run(); toasts = toasts.filter((x) => x.id !== t.id); notify(); }}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ dialog */

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("button, input")?.focus();
    return () => { document.removeEventListener("keydown", onKey); prev?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" className={cx("pop-in max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-card p-5 shadow-pop sm:rounded-2xl", wide ? "sm:max-w-2xl" : "sm:max-w-md")}>
        {title && (
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-[16px] font-semibold">{title}</h3>
            <button className="btn btn-ghost -mr-2 size-9 p-0" onClick={onClose} aria-label="Tutup"><X size={18} /></button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

type ConfirmOpts = { title: string; body?: ReactNode; confirm?: string; danger?: boolean };
let confirmState: (ConfirmOpts & { resolve: (v: boolean) => void }) | null = null;
const confirmSubs = new Set<() => void>();
export function confirmDialog(o: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => { confirmState = { ...o, resolve }; confirmSubs.forEach((f) => f()); });
}
export function ConfirmHost() {
  const s = useSyncExternalStore((f) => { confirmSubs.add(f); return () => confirmSubs.delete(f); }, () => confirmState);
  const close = (v: boolean) => { s?.resolve(v); confirmState = null; confirmSubs.forEach((f) => f()); };
  return (
    <Modal open={!!s} onClose={() => close(false)} title={s?.title}>
      {s?.body && <div className="text-[14px] text-muted">{s.body}</div>}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn" onClick={() => close(false)}>Batal</button>
        <button className={cx("btn", s?.danger ? "btn-danger" : "btn-primary")} onClick={() => close(true)}>{s?.confirm ?? "Ya, lanjut"}</button>
      </div>
    </Modal>
  );
}

export function useMediaQuery(q: string) {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}
