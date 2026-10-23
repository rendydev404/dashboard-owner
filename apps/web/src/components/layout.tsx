import { useState, useSyncExternalStore, type ReactNode } from "react";
import {
  LayoutGrid, Megaphone, Clock3, Package, Wallet, Bot, Settings, LogOut, Menu, X, MessageCircle, MoreHorizontal,
  AlertTriangle, Download, Printer, RefreshCw, Plug,
} from "lucide-react";
import { fmtRange, type Bootstrap } from "@iklan/shared";
import { setView, useView, type Tab } from "../lib/view";
import { api, queryClient } from "../lib/api";
import { PeriodPicker, QuickFilters, ThemeToggle } from "./pickers";
import { cx, Modal } from "./ui";
import { AdBot } from "./AdBot";

/* ------------------------------------------------------------------ chat open state */
let chatOpen = false;
const chatSubs = new Set<() => void>();
export const setChatOpen = (v: boolean) => { chatOpen = v; chatSubs.forEach((f) => f()); };
export const useChatOpen = () => useSyncExternalStore((f) => { chatSubs.add(f); return () => chatSubs.delete(f); }, () => chatOpen);

const NAV: { tab: Tab; label: string; icon: typeof LayoutGrid }[] = [
  { tab: "ringkasan", label: "Ringkasan", icon: LayoutGrid },
  { tab: "kampanye", label: "Kampanye", icon: Megaphone },
  { tab: "jam", label: "Per Jam", icon: Clock3 },
  { tab: "produk", label: "Produk & Jasa", icon: Package },
  { tab: "labarugi", label: "Laba Rugi", icon: Wallet },
  { tab: "chat", label: "Chat AI", icon: MessageCircle },
  { tab: "bot", label: "Bot AI", icon: Bot },
];
export const TAB_TITLE: Record<Tab, string> = {
  ringkasan: "Ringkasan", kampanye: "Kampanye", jam: "Per Jam", produk: "Produk & Jasa", labarugi: "Laba Rugi", chat: "Chat AI", bot: "Bot AI", pengaturan: "Pengaturan",
};

async function logout() {
  await api("/auth/logout", { method: "POST" }).catch(() => {});
  queryClient.clear();
  location.href = "/";
}

function Logo({ collapsed }: { collapsed?: boolean }) {
  return (
    <div className={cx("flex items-center gap-2.5", collapsed && "justify-center")}>
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
        <path d="M14 3c3 0 5 2.5 5 5.5S16 14 14 14 9 11.5 9 8.5 11 3 14 3Z" fill="#6366F1" />
        <path d="M25 14c0 3-2.5 5-5.5 5S14 16 14 14s2.5-5 5.5-5S25 11 25 14Z" fill="#EC4899" />
        <path d="M14 25c-3 0-5-2.5-5-5.5S12 14 14 14s5 2.5 5 5.5S17 25 14 25Z" fill="#8B5CF6" />
        <path d="M3 14c0-3 2.5-5 5.5-5S14 12 14 14s-2.5 5-5.5 5S3 17 3 14Z" fill="#3B82F6" />
      </svg>
      {!collapsed && <span className="text-[19px] font-semibold tracking-tight">Iklan AI</span>}
    </div>
  );
}

function BotCard() {
  const [wave, setWave] = useState(0);
  return (
    <div className="relative mt-auto overflow-hidden rounded-2xl bg-accent-soft p-4 pt-[86px]">
      <button type="button" className="absolute left-1/2 top-2 -translate-x-1/2 rounded-full" onClick={() => setWave((w) => w + 1)} onMouseEnter={() => setWave((w) => w + 1)} aria-label="Sapa bot">
        <AdBot size={80} track wave={wave} />
      </button>
      <p className="text-center text-[13px] font-semibold leading-snug">Butuh analisis?<br /><span className="font-normal text-muted">Tanya bot soal angka & iklan</span></p>
      <button className="btn btn-primary mx-auto mt-3 flex h-9 min-h-0 rounded-full px-4 text-[12.5px]" onClick={() => setChatOpen(true)}>Tanya bot</button>
    </div>
  );
}

function NavItem({ tab, label, icon: Icon, collapsed, onClick }: { tab?: Tab; label: string; icon: typeof LayoutGrid; collapsed?: boolean; onClick?: () => void }) {
  const v = useView();
  const on = tab && v.tab === tab;
  return (
    <button onClick={onClick ?? (() => tab && setView({ tab }))} title={collapsed ? label : undefined} aria-current={on ? "page" : undefined}
      className={cx("nav-item flex h-10 w-full items-center gap-3 rounded-[10px] px-3 text-[14px] transition-colors",
        collapsed && "justify-center px-0",
        on ? "nav-active font-semibold" : "text-ink/80 hover:text-ink")}>
      <Icon size={18} strokeWidth={on ? 2.2 : 1.8} className="shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  );
}

function SidebarContent({ collapsed, onNav }: { collapsed?: boolean; onNav?: () => void }) {
  const wrap = (fn?: () => void) => () => { fn?.(); onNav?.(); };
  return (
    <div className="flex h-full flex-col">
      <div className={cx("px-5 pb-8 pt-7", collapsed && "px-0")}><Logo collapsed={collapsed} /></div>
      <nav className={cx("space-y-1 px-3", collapsed && "px-3")} aria-label="Menu utama">
        {NAV.map((n) => <NavItem key={n.tab} {...n} collapsed={collapsed} onClick={wrap(() => setView({ tab: n.tab }))} />)}
      </nav>
      <div className="mx-0 my-5 border-t border-line" />
      <div className="space-y-1 px-3">
        <NavItem tab="pengaturan" label="Pengaturan" icon={Settings} collapsed={collapsed} onClick={wrap(() => setView({ tab: "pengaturan" }))} />
        <NavItem label="Keluar" icon={LogOut} collapsed={collapsed} onClick={logout} />
      </div>
      {!collapsed && <div className="mt-auto flex flex-1 flex-col justify-end px-4 pb-5 pt-6"><BotCard /></div>}
    </div>
  );
}

function SyncBanner({ boot }: { boot: Bootstrap }) {
  const i = boot.integration;
  const fmt = (iso: string) => new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const warn = "mb-4 flex items-start gap-2 rounded-xl border border-yellow/40 bg-yellow-soft px-4 py-2.5 text-[13px] text-yellow-ink";
  if (!i.metaConfigured)
    return (
      <div className={warn}>
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <span>Meta belum terhubung ke server. Data iklan yang tampil adalah hasil impor terakhir{i.lastSyncAt ? ` (${fmt(i.lastSyncAt)})` : ""}. Login Claude Code di VPS (user claude-ads) atau pasang token System User supaya sinkron otomatis.</span>
      </div>
    );
  if (i.metaError)
    return (
      <div className="mb-4 flex items-start gap-2 rounded-xl bg-red-soft px-4 py-2.5 text-[13px] text-red-ink">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>Sinkron Meta bermasalah: {i.metaError}</span>
      </div>
    );
  if (i.metaTokenExpiresAt) {
    const days = Math.floor((new Date(i.metaTokenExpiresAt).getTime() - Date.now()) / 864e5);
    if (days <= 7)
      return (
        <div className={warn}>
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>Login Meta Ads di Claude Code VPS berakhir {days <= 0 ? "hari ini" : `dalam ${days} hari`} ({fmt(i.metaTokenExpiresAt)}). Login ulang (user claude-ads) supaya sinkron tidak berhenti.</span>
        </div>
      );
  }
  if (i.lastSyncAt) {
    const age = (Date.now() - new Date(i.lastSyncAt).getTime()) / 60000;
    if (age > 60)
      return (
        <div className={warn}>
          <RefreshCw size={15} className="mt-0.5 shrink-0" /> <span>Data Meta terakhir sinkron {fmt(i.lastSyncAt)}</span>
        </div>
      );
  }
  return null;
}

function LynkBanner({ boot }: { boot: Bootstrap }) {
  const i = boot.integration;
  const info = "mb-4 flex flex-wrap items-start gap-x-2 gap-y-1 rounded-xl border border-accent/30 bg-accent-soft px-4 py-2.5 text-[13px]";
  if (!i.lynkConfigured)
    return <div className={info}><Plug size={16} className="mt-0.5 shrink-0 text-accent" /><span><b>lynk.id belum terhubung.</b> Isi merchant key di server supaya penjualan produk digital masuk otomatis.</span></div>;
  if (!i.lastLynkAt)
    return (
      <div className={info}>
        <Plug size={16} className="mt-0.5 shrink-0 text-accent" />
        <span><b>Belum ada transaksi lynk.id yang masuk.</b> Omzet, ROAS riil, dan laba terisi setelah webhook menerima transaksi atau riwayat lama diimpor.</span>
        <button className="font-semibold text-accent underline-offset-2 hover:underline" onClick={() => setView({ tab: "pengaturan" })}>Lihat URL webhook</button>
      </div>
    );
  return null;
}

export function Shell({ boot, children }: { boot: Bootstrap; children: ReactNode }) {
  const v = useView();
  const [drawer, setDrawer] = useState(false);
  const [more, setMore] = useState(false);
  const initials = boot.user.name.split(/\s+/).map((s) => s[0]).slice(0, 2).join("").toUpperCase();
  const exportUrl = `/api/export/campaigns.csv?${new URLSearchParams({ acc: v.acc, from: v.from, to: v.to })}`;

  return (
    <div className="min-h-dvh lg:pl-[76px] xl:pl-[240px]">
      {/* Sidebar: rail 76px (lg), penuh 240px (xl) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[76px] border-r border-line bg-panel lg:block xl:hidden"><SidebarContent collapsed /></aside>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[240px] border-r border-line bg-panel xl:block"><SidebarContent /></aside>
      {drawer && (
        <div className="fixed inset-0 z-50 bg-black/40 lg:hidden" onMouseDown={(e) => e.target === e.currentTarget && setDrawer(false)}>
          <aside className="pop-in h-full w-[260px] bg-panel"><SidebarContent onNav={() => setDrawer(false)} /></aside>
        </div>
      )}

      <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur md:border-0 md:bg-bg">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 md:px-8 md:pt-7 md:pb-2">
          <button className="btn btn-ghost -ml-2 hidden size-10 p-0 md:inline-flex lg:hidden" onClick={() => setDrawer(true)} aria-label="Buka menu"><Menu size={20} /></button>
          <h1 className="mr-auto text-[22px] font-semibold tracking-tight md:mr-0 md:text-[26px]">{TAB_TITLE[v.tab]}</h1>
          <div className="order-3 flex w-full min-w-0 items-center gap-2 md:order-none md:w-auto md:flex-1">
            <PeriodPicker />
          </div>
          <div className="no-print flex items-center gap-1 md:gap-3">
            <a href={exportUrl} className="btn btn-ghost hidden size-9 p-0 md:inline-flex" title="Unduh CSV kampanye" aria-label="Unduh CSV"><Download size={17} /></a>
            <button onClick={() => window.print()} className="btn btn-ghost hidden size-9 p-0 md:inline-flex" title="Unduh PDF (cetak)" aria-label="Cetak / PDF"><Printer size={17} /></button>
            <ThemeToggle />
            <div className="ml-1 hidden items-center gap-2.5 sm:flex">
              <div className="grid size-9 place-items-center rounded-full bg-accent text-[13px] font-semibold text-accent-ink">{initials}</div>
              <div className="hidden leading-tight xl:block">
                <p className="text-[13px] font-semibold">{boot.user.name}</p>
                <p className="text-[11.5px] capitalize text-muted">{boot.user.role}</p>
              </div>
            </div>
          </div>
        </div>
        {v.tab !== "pengaturan" && (
          <div className="mx-auto max-w-[1320px] px-4 pb-3 md:px-8">
            <QuickFilters accounts={boot.accounts} />
          </div>
        )}
      </header>

      <main className="mx-auto max-w-[1320px] px-4 pb-32 pt-3 md:px-8 md:pb-16">
        {v.tab !== "chat" && <SyncBanner boot={boot} />}
        {v.tab !== "chat" && !(v.tab === "ringkasan" && v.sub === "lynk") && <LynkBanner boot={boot} />}
        {children}
        {v.tab !== "chat" && <p className="mt-10 text-center text-[12px] text-muted">Laporan internal · jangan dibagikan · {v.from && fmtRange(v.from, v.to)}</p>}
      </main>

      {/* Bottom nav (HP) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" aria-label="Menu">
        <div className="grid grid-cols-5">
          {([["ringkasan", "Ringkasan", LayoutGrid], ["kampanye", "Kampanye", Megaphone], ["labarugi", "Laba Rugi", Wallet], ["chat", "Chat", MessageCircle]] as const).map(([t, l, Icon]) => (
            <button key={t} onClick={() => setView({ tab: t })} className={cx("flex h-[58px] flex-col items-center justify-center gap-1 text-[11px]", v.tab === t ? "font-semibold text-accent" : "text-muted")}>
              <Icon size={20} strokeWidth={v.tab === t ? 2.3 : 1.8} />{l}
            </button>
          ))}
          <button onClick={() => setMore(true)} className={cx("flex h-[58px] flex-col items-center justify-center gap-1 text-[11px]", ["jam", "produk", "bot", "pengaturan"].includes(v.tab) ? "font-semibold text-accent" : "text-muted")}>
            <MoreHorizontal size={20} />Lainnya
          </button>
        </div>
      </nav>
      <Modal open={more} onClose={() => setMore(false)} title="Menu lainnya">
        <div className="space-y-1">
          {([["jam", "Per Jam", Clock3], ["produk", "Produk & Jasa", Package], ["bot", "Bot AI", Bot], ["pengaturan", "Pengaturan", Settings]] as const).map(([t, l, Icon]) => (
            <NavItem key={t} tab={t} label={l} icon={Icon} onClick={() => { setView({ tab: t }); setMore(false); }} />
          ))}
          <a href={exportUrl} className="flex h-10 items-center gap-3 rounded-[10px] px-3 text-[14px] hover:bg-hover"><Download size={18} /> Unduh CSV kampanye</a>
          <NavItem label="Keluar" icon={LogOut} onClick={logout} />
        </div>
      </Modal>

      {v.tab !== "chat" && <button onClick={() => setChatOpen(true)} className="chat-fab no-print fixed bottom-[76px] right-4 z-30 flex h-12 items-center gap-2 rounded-full bg-accent px-4 font-semibold text-accent-ink shadow-pop md:bottom-6 md:right-6 md:px-5" aria-label="Buka chat bot">
        <span className="-ml-2 grid size-9 place-items-center rounded-full bg-accent-soft sm:-ml-3"><AdBot size={28} head /></span> <span className="hidden sm:inline">Tanya bot</span>
      </button>}
    </div>
  );
}

