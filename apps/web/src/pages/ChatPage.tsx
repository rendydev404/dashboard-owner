import ChatView from "../chat/ChatView";

/** Chat bot layar penuh. Percakapan sama dengan panel melayang (state bersama). */
export default function ChatPage() {
  return (
    <div className="card -mb-24 flex h-[calc(100dvh-248px)] min-h-[500px] flex-col overflow-hidden p-0 md:mb-0 md:h-[calc(100dvh-184px)]">
      <ChatView variant="page" />
    </div>
  );
}
