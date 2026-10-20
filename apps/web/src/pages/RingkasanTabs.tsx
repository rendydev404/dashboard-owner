import { lazy, Suspense } from "react";
import { LayoutGrid, Megaphone, ShoppingBag } from "lucide-react";
import { setView, useView, type Sub } from "../lib/view";
import { Card, Skeleton, cx } from "../components/ui";
import Ringkasan from "./Ringkasan";

// Dua tab statistik dimuat saat dibuka.
const FacebookAds = lazy(() => import("./FacebookAds"));
const LynkStats = lazy(() => import("./LynkStats"));

const TABS: { id: Sub; label: string; icon: typeof LayoutGrid; hint: string }[] = [
  { id: "all", label: "Ringkasan", icon: LayoutGrid, hint: "Laba gabungan" },
  { id: "fb", label: "Facebook Ads", icon: Megaphone, hint: "Spend & performa iklan" },
  { id: "lynk", label: "lynk.id", icon: ShoppingBag, hint: "Penjualan & omzet" },
];

/** Halaman Ringkasan dengan tab: gabungan, statistik Facebook Ads, dan statistik lynk.id. */
export default function RingkasanTabs() {
  const v = useView();
  return (
    <div>
      <div role="tablist" aria-label="Sumber statistik" className="mb-4 grid grid-cols-3 gap-1 rounded-2xl border border-line bg-card p-1 sm:inline-grid sm:w-auto">
        {TABS.map((t) => {
          const on = v.sub === t.id, Icon = t.icon;
          return (
            <button key={t.id} role="tab" aria-selected={on} onClick={() => setView({ sub: t.id })} title={t.hint}
              className={cx("flex h-10 items-center justify-center gap-2 rounded-xl px-3 text-[13.5px] font-semibold transition-colors sm:px-5",
                on ? "bg-accent text-accent-ink shadow-sm" : "text-muted hover:bg-hover hover:text-ink")}>
              <Icon size={16} className="shrink-0" /><span className="truncate">{t.label}</span>
            </button>
          );
        })}
      </div>
      {v.sub === "all" && <Ringkasan />}
      {v.sub !== "all" && (
        <Suspense fallback={<Card><Skeleton className="h-[360px]" /></Card>}>
          {v.sub === "fb" ? <FacebookAds /> : <LynkStats />}
        </Suspense>
      )}
    </div>
  );
}
