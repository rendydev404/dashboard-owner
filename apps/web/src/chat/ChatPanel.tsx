import { useEffect, useRef, useState } from "react";
import { X, Send, Bot, Zap, Check, Undo2 } from "lucide-react";
import { parseIntent, fmtRange, PRESET_LABELS, rpk, dec, type BotAction, type ChatEvent, type RuleField } from "@iklan/shared";
import { api, useBootstrap, actionsApi, refreshData, ApiError } from "../lib/api";
import { setView, getView, useView } from "../lib/view";
import { actionSummary } from "../lib/campaign-action";
import { accLabel } from "../components/pickers";
import { setChatOpen, useChatOpen } from "../components/layout";
import { Markdownish, toast, cx } from "../components/ui";

type Msg = { id: number; role: "user" | "bot"; text: string; ctx?: string; action?: BotAction; error?: boolean };
const CHIPS = ["Laba bulan lalu?", "Rekomendasi", "Kampanye paling boros?", "Akun jasa minggu ini", "Jam paling cuan?", "Produk terlaris"];
const RULE_LABEL: Record<RuleField, [string, (v: number) => string]> = {
  targetRoas: ["Target ROAS", (v) => dec(v) + "x"], maxCpa: ["Batas CPA", rpk], maxCpl: ["Batas CPL", rpk],
  killAfterSpend: ["Matikan setelah spend", rpk], scaleStepPct: ["Kenaikan budget saat scale", (v) => `+${v}%`],
};
let mid = 0;

function ActionCard({ action, onUpdate }: { action: BotAction; onUpdate: (a: BotAction) => void }) {
  const [busy, setBusy] = useState(false);
  const s = actionSummary(action);
  const p = action.params as any;
  const run = async (kind: "confirm" | "cancel" | "revert") => {
    setBusy(true);
    try {
      const a = await actionsApi[kind](action.id);
      onUpdate(a);
      if (kind === "confirm") a.status === "executed" ? toast(`${s.verb}: ${a.campaignName} berhasil`) : toast(`Gagal: ${a.error}`, { tone: "err" });
      refreshData();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Gagal", { tone: "err" });
    }
    setBusy(false);
  };
  const expired = action.status === "pending" && action.expiresAt && new Date(action.expiresAt) < new Date();
  return (
    <div className="mt-2 rounded-xl border border-line bg-card p-3 text-[13px]">
      <p className="flex items-center gap-1.5 font-semibold"><Zap size={14} className="text-accent" /> {s.title.replace("?", "")}</p>
      <p className="mt-1 font-medium">{action.campaignName}</p>
      <p className="text-[12px] text-muted">{action.accountName}</p>
      <p className="mt-1.5 whitespace-pre-line rounded-lg bg-bg px-2.5 py-1.5 text-[12.5px]">{s.detail}</p>
      {p.demo && <p className="mt-1 text-[11.5px] text-muted">Mode demo: hanya tersimpan di dashboard.</p>}
      {action.status === "pending" && !expired ? (
        <div className="mt-2.5 flex gap-2">
          <button className="btn btn-primary h-9 min-h-0 flex-1" disabled={busy} onClick={() => run("confirm")}>Ya, eksekusi</button>
          <button className="btn h-9 min-h-0" disabled={busy} onClick={() => run("cancel")}>Batal</button>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between gap-2 text-[12px]">
          <span className={cx("font-semibold", action.status === "executed" ? "text-green-ink" : action.status === "failed" ? "text-red-ink" : "text-muted")}>
            {action.status === "executed" ? <span className="inline-flex items-center gap-1"><Check size={13} /> Dieksekusi</span>
              : action.status === "failed" ? `Gagal: ${action.error}` : expired ? "Kedaluwarsa" : action.status === "reverted" ? "Dibalikkan" : "Dibatalkan"}
          </span>
          {action.status === "executed" && !p.demo && <button className="inline-flex items-center gap-1 font-semibold text-accent" disabled={busy} onClick={() => run("revert")}><Undo2 size={13} /> Batalkan aksi</button>}
        </div>
      )}
    </div>
  );
}

export default function ChatPanel() {
  const open = useChatOpen();
  const boot = useBootstrap().data!;
  const view = useView();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const conv = useRef(crypto.randomUUID());
  const owner = boot.user.role === "owner";

  useEffect(() => {
    if (open && !msgs.length)
      setMsgs([{ id: ++mid, role: "bot", text: "Halo! Gw bot iklan lo. Tanya angka, pindah akun atau periode, ubah aturan, sampai pause / scale kampanye, semua bisa dari sini." }]);
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open, msgs.length]);
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight, behavior: "smooth" }); }, [msgs]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && open && setChatOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const ctxLine = () => { const v = getView(); return `${accLabel(v.acc, boot.accounts)} · ${fmtRange(v.from, v.to)}`; };
  const push = (m: Omit<Msg, "id">) => { const id = ++mid; setMsgs((x) => [...x, { ...m, id }]); return id; };
  const patch = (id: number, f: (m: Msg) => Msg) => setMsgs((x) => x.map((m) => (m.id === id ? f(m) : m)));
  const pendingAction = () => [...msgs].reverse().find((m) => m.action?.status === "pending")?.action;

  async function send(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;
    setInput("");
    push({ role: "user", text });
    const it = parseIntent(text, boot.accounts);

    // 1) Konfirmasi "ya"/"batal" untuk kartu aksi terakhir — diproses lokal, bukan oleh AI.
    if (it.confirm) {
      const pa = pendingAction();
      if (pa) {
        try {
          const a = it.confirm === "yes" ? await actionsApi.confirm(pa.id) : await actionsApi.cancel(pa.id);
          setMsgs((x) => x.map((m) => (m.action?.id === a.id ? { ...m, action: a } : m)));
          push({ role: "bot", text: a.status === "executed" ? `Beres, **${a.campaignName}** sudah dieksekusi.` : a.status === "failed" ? `Gagal: ${a.error}` : "Oke, dibatalkan." });
          refreshData();
        } catch (e) { push({ role: "bot", text: (e as Error).message, error: true }); }
        return;
      }
    }

    // 2) Pindah tampilan lokal.
    const moved = (it.acc && it.acc !== getView().acc) || it.preset;
    if (moved) setView({ ...(it.acc ? { acc: it.acc } : {}), ...(it.preset ? { preset: it.preset } : {}) });

    // 3) Ubah aturan lokal (owner).
    if (it.rule) {
      if (!owner) { push({ role: "bot", text: "Hanya owner yang bisa mengubah aturan.", error: true }); return; }
      const v = getView();
      const ids = boot.accounts.filter((a) => a.active && (v.acc === "all" || v.acc === a.id || v.acc === a.line)).map((a) => a.id);
      const [label, fmt] = RULE_LABEL[it.rule.field];
      try {
        await Promise.all(ids.map((id) => api(`/accounts/${id}/settings`, { method: "PATCH", json: { [it.rule!.field]: it.rule!.value } })));
        refreshData();
        push({ role: "bot", ctx: ctxLine(), text: `${label} untuk ${ids.length > 1 ? "semua akun terpilih" : boot.accounts.find((a) => a.id === ids[0])?.name} sekarang **${fmt(it.rule.value)}**.` });
      } catch (e) { push({ role: "bot", text: (e as Error).message, error: true }); }
      return;
    }

    if (moved && !it.hasQuestion) {
      const v = getView();
      push({ role: "bot", text: `Oke, dashboard pindah ke **${accLabel(v.acc, boot.accounts)}** · ${v.preset !== "custom" ? PRESET_LABELS[v.preset] : fmtRange(v.from, v.to)}.` });
      return;
    }

    // 4) Sisanya ke backend (Claude, atau mode aturan kalau API key belum ada).
    setBusy(true);
    const v = getView();
    const botId = push({ role: "bot", text: "", ctx: ctxLine() });
    const history = msgs.filter((m) => m.text && !m.error).slice(-12).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ message: text, history, context: { acc: v.acc, from: v.from, to: v.to }, conversationId: conv.current }),
      });
      if (!res.ok || !res.body) throw new ApiError((await res.json().catch(() => ({}))).error || "Bot tidak bisa dihubungi", res.status);
      const reader = res.body.getReader(), dec8 = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec8.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const e = JSON.parse(line.slice(5)) as ChatEvent;
          if (e.type === "text") patch(botId, (m) => ({ ...m, text: m.text + e.text }));
          else if (e.type === "action_card") push({ role: "bot", text: "", action: e.action });
          else if (e.type === "view") setView({ ...(e.acc ? { acc: e.acc } : {}), ...(e.preset ? { preset: e.preset } : e.from && e.to ? { preset: "custom", from: e.from, to: e.to } : {}) });
          else if (e.type === "rule_changed") refreshData();
          else if (e.type === "error") patch(botId, (m) => ({ ...m, text: m.text + (m.text ? "\n\n" : "") + e.message, error: true }));
        }
      }
    } catch (e) {
      patch(botId, (m) => ({ ...m, text: (e as Error).message, error: true }));
    }
    setMsgs((x) => x.filter((m) => m.id !== botId || m.text));
    setBusy(false);
  }

  if (!open) return null;
  return (
    <aside className="pop-in fixed inset-0 z-[55] flex flex-col bg-card md:inset-auto md:bottom-6 md:right-6 md:h-[min(640px,calc(100dvh-48px))] md:w-[400px] md:rounded-2xl md:border md:border-line md:shadow-pop" aria-label="Chat bot iklan">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 pt-[max(12px,env(safe-area-inset-top))]">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-full bg-accent text-accent-ink"><Bot size={18} /></span>
          <div className="leading-tight"><p className="font-semibold">Bot Iklan</p><p className="text-[11.5px] text-muted">{boot.integration.aiConfigured ? "Terhubung ke AI" : "Mode aturan · AI belum diaktifkan"} · {accLabel(view.acc, boot.accounts)}</p></div>
        </div>
        <button className="btn btn-ghost size-9 p-0" onClick={() => setChatOpen(false)} aria-label="Tutup chat"><X size={18} /></button>
      </div>
      <div ref={body} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
        {msgs.map((m) => m.role === "user" ? (
          <div key={m.id} className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2.5 text-[13.5px] text-accent-ink">{m.text}</div>
        ) : (
          <div key={m.id} className="max-w-[92%]">
            {(m.text || !m.action) && (
              <div className={cx("rounded-2xl rounded-bl-md px-3.5 py-2.5 text-[13.5px] leading-relaxed", m.error ? "bg-red-soft text-red-ink" : "bg-bg")}>
                {m.ctx && <p className="mb-1 text-[11px] font-semibold text-muted">{m.ctx}</p>}
                {m.text ? <Markdownish text={m.text} /> : <span className="inline-flex gap-1 text-muted"><span className="animate-pulse">●</span><span className="animate-pulse [animation-delay:150ms]">●</span><span className="animate-pulse [animation-delay:300ms]">●</span></span>}
              </div>
            )}
            {m.action && <ActionCard action={m.action} onUpdate={(a) => patch(m.id, (x) => ({ ...x, action: a }))} />}
          </div>
        ))}
      </div>
      <div className="flex gap-2 overflow-x-auto px-4 pb-2 scrollbar-none">
        {CHIPS.map((c) => <button key={c} onClick={() => send(c)} disabled={busy} className="shrink-0 rounded-full border border-line px-3 py-1.5 text-[12px] font-medium hover:border-accent hover:text-accent">{c}</button>)}
      </div>
      <form className="flex gap-2 border-t border-line px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))]" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <input ref={inputRef} className="input" placeholder="Contoh: laba bulan lalu berapa?" value={input} onChange={(e) => setInput(e.target.value)} maxLength={2000} aria-label="Pesan untuk bot" />
        <button className="btn btn-primary size-[42px] shrink-0 p-0" disabled={busy || !input.trim()} aria-label="Kirim"><Send size={17} /></button>
      </form>
    </aside>
  );
}
