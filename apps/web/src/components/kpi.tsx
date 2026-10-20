import type { ReactNode } from "react";
import { cx, Delta, Skeleton } from "./ui";

export function KpiCard({ label, value, sub, icon, cur, prev, goodUp, tone, highlight }: {
  label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode;
  cur: number; prev: number | null | undefined; goodUp: boolean | null; tone?: "pos" | "neg"; highlight?: boolean;
}) {
  return (
    <div className={cx("card flex min-w-0 flex-col p-4 md:p-5", highlight && "border-accent/40 bg-[linear-gradient(180deg,var(--accent-soft),var(--card)_75%)]")}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium text-ink/80">{label}</p>
        {icon && <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line text-ink/70">{icon}</span>}
      </div>
      <p className={cx("num mt-2 truncate text-[22px] font-medium tracking-tight md:text-[28px]", tone === "pos" && "text-green-ink", tone === "neg" && "text-red-ink")}>{value}</p>
      {sub && <p className="mt-0.5 truncate text-[12px] text-muted">{sub}</p>}
      <div className="mt-auto pt-2"><Delta cur={cur} prev={prev} goodUp={goodUp} /></div>
    </div>
  );
}

export function KpiSkeleton() {
  return (
    <div className="card p-4 md:p-5">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="mt-3 h-8 w-28" />
      <Skeleton className="mt-2 h-3 w-24" />
      <Skeleton className="mt-4 h-3 w-32" />
    </div>
  );
}
