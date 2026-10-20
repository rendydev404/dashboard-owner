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
    <aside className="pop-in fixed inset-0 z-[55] flex flex-col bg-card md:inset-auto md:bottom-6 md:right-6 md:h-[min(680px,calc(100dvh-48px))] md:w-[440px] md:rounded-2xl md:border md:border-line md:shadow-pop" aria-label="Chat bot iklan">
      <ChatView variant="panel" onClose={() => setChatOpen(false)} />
    </aside>
  );
}
