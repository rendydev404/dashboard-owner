import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ServerEvent } from "@iklan/shared";
import { rpk } from "@iklan/shared";
import { useBootstrap, refreshData, ApiError, queryClient } from "./lib/api";
import { initView, useView } from "./lib/view";
import { Shell } from "./components/layout";
import { ConfirmHost, Toaster, toast, Skeleton } from "./components/ui";
import Ringkasan from "./pages/RingkasanTabs";
import Login from "./pages/Login";

// Halaman selain Ringkasan dimuat saat dibuka (chunk terpisah).
const Kampanye = lazy(() => import("./pages/Kampanye"));
const PerJam = lazy(() => import("./pages/PerJam"));
const Produk = lazy(() => import("./pages/Produk"));
const LabaRugi = lazy(() => import("./pages/LabaRugi"));
const ChatPage = lazy(() => import("./pages/ChatPage"));
const Pengaturan = lazy(() => import("./pages/Pengaturan"));
const ChatPanel = lazy(() => import("./chat/ChatPanel"));
const prefetch = () => { void import("./pages/Kampanye"); void import("./pages/LabaRugi"); void import("./chat/ChatPanel"); };

/** Realtime: server hanya mengirim "versi data berubah"; client invalidasi query dengan debounce. */
function useServerEvents(enabled: boolean) {
  const last = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as ServerEvent;
      if (e.type === "version") {
        if (last.current && e.v !== last.current) { clearTimeout(timer); timer = setTimeout(() => refreshData(), 2000); }
        last.current = e.v;
      } else if (e.type === "sale") toast(`Penjualan baru ${rpk(e.amount)}${e.product ? ` · ${e.product}` : ""}`, { tone: "info" });
    };
    return () => { clearTimeout(timer); es.close(); };
  }, [enabled]);
}

function Page() {
  const v = useView();
  const map = { ringkasan: Ringkasan, kampanye: Kampanye, jam: PerJam, produk: Produk, labarugi: LabaRugi, chat: ChatPage, pengaturan: Pengaturan };
  const C = map[v.tab];
  return <Suspense fallback={<div className="card p-5"><Skeleton className="h-[360px]" /></div>}><C /></Suspense>;
}

export default function App() {
  const boot = useBootstrap();
  const [ready, setReady] = useState(false);
  const authed = !!boot.data;

  useEffect(() => {
    if (!boot.data) return;
    const accs = boot.data.accounts;
    initView(boot.data.today, (a) => a === "all" || a === "digital" || a === "jasa" || accs.some((x) => x.id === a));
    setReady(true);
    const t = setTimeout(prefetch, 1500);
    return () => clearTimeout(t);
  }, [boot.data]);
  useEffect(() => {
    const on = () => queryClient.resetQueries({ queryKey: ["bootstrap"] });
    window.addEventListener("iklan:unauthorized", on);
    return () => window.removeEventListener("iklan:unauthorized", on);
  }, []);
  useServerEvents(authed);

  const unauth = boot.error instanceof ApiError && boot.error.status === 401;
  return (
    <>
      {unauth ? <Login /> : !boot.data || !ready ? (
        <div className="grid min-h-dvh place-items-center text-muted">{boot.error ? <p>{(boot.error as Error).message}</p> : <div className="skeleton size-10 rounded-full" />}</div>
      ) : (
        <Shell boot={boot.data}>
          <Page />
          <Suspense fallback={null}><ChatPanel /></Suspense>
        </Shell>
      )}
      <Toaster />
      <ConfirmHost />
    </>
  );
}
