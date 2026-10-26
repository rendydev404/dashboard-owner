import { useEffect } from "react";
import { setChatOpen, useChatOpen } from "../components/layout";
import { useView } from "../lib/view";
import ChatView from "./ChatView";

/** Panel chat melayang (desktop) / layar penuh (HP). Tidak tampil di halaman chat penuh. */
export default function ChatPanel() {
  const open = useChatOpen();
  const { tab } = useView();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && open && setChatOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open || tab === "chat") return null;
  return (
    <aside className="pop-in fixed inset-0 z-[55] flex flex-col overflow-hidden bg-card md:inset-auto md:bottom-5 md:right-5 md:h-[min(720px,calc(100dvh-40px))] md:w-[460px] md:rounded-2xl md:border md:border-line md:shadow-pop" aria-label="Chat bot iklan">
      <ChatView variant="panel" onClose={() => setChatOpen(false)} />
    </aside>
  );
}
