import ChatView from "../chat/ChatView";

/** Chat bot layar penuh. Percakapan sama dengan panel melayang (state bersama). */
export default function ChatPage() {
  return (
    <div className="card -mb-24 flex h-[calc(100dvh-262px)] min-h-[440px] flex-col p-3 md:mb-0 md:h-[calc(100dvh-196px)] md:p-5">
      <ChatView variant="page" />
    </div>
  );
}
