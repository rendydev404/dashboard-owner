// State chat bersama untuk panel melayang dan halaman chat penuh, supaya percakapan tidak hilang saat berpindah.
import { useSyncExternalStore } from "react";
import {
  parseIntent, fmtRange, PRESET_LABELS, rpk, dec, attachmentLine,
  type Account, type BotAction, type ChatAttachment, type ChatEvent, type ChatWidget, type RuleField,
} from "@iklan/shared";
import { api, actionsApi, refreshData, ApiError } from "../lib/api";
import { setView, getView } from "../lib/view";
import { accLabel } from "../components/pickers";

export type Part = { type: "text"; text: string } | { type: "widget"; widget: ChatWidget };
/** Lampiran yang sudah terkirim; `preview` object URL lokal untuk ditampilkan di gelembung chat. */
export type SentFile = ChatAttachment & { preview: string };
export type Msg = { id: number; role: "user" | "bot"; parts: Part[]; ctx?: string; action?: BotAction; error?: boolean; files?: SentFile[] };

const RULE_LABEL: Record<RuleField, [string, (v: number) => string]> = {
  targetRoas: ["Target ROAS", (v) => dec(v) + "x"], maxCpa: ["Batas CPA", rpk], maxCpl: ["Batas CPL", rpk],
  killAfterSpend: ["Matikan setelah spend", rpk], scaleStepPct: ["Kenaikan budget saat scale", (v) => `+${v}%`],
};

interface State { msgs: Msg[]; busy: boolean }
let state: State = { msgs: [], busy: false };
let conv = crypto.randomUUID();
let mid = 0;
let abort: AbortController | null = null;
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; subs.forEach((f) => f()); };
export const useChat = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);

export const textOf = (m: Msg) => m.parts.filter((p): p is Extract<Part, { type: "text" }> => p.type === "text").map((p) => p.text).join("");
const push = (m: Omit<Msg, "id">) => { const id = ++mid; set({ msgs: [...state.msgs, { ...m, id }] }); return id; };
const patch = (id: number, f: (m: Msg) => Msg) => set({ msgs: state.msgs.map((m) => (m.id === id ? f(m) : m)) });
const botText = (text: string, extra: Partial<Msg> = {}) => push({ role: "bot", parts: [{ type: "text", text }], ...extra });
const appendText = (id: number, t: string) => patch(id, (m) => {
  const last = m.parts[m.parts.length - 1];
  return last?.type === "text" ? { ...m, parts: [...m.parts.slice(0, -1), { type: "text", text: last.text + t }] } : { ...m, parts: [...m.parts, { type: "text", text: t }] };
});

export function greet() {
  if (!state.msgs.length) botText("Halo! Gw bot iklan lo, otaknya Claude. Tanya angka, minta analisis, pindah akun atau periode, ubah aturan, sampai pause / scale kampanye, semua bisa dari sini.");
}
export function updateAction(a: BotAction) { set({ msgs: state.msgs.map((m) => (m.action?.id === a.id ? { ...m, action: a } : m)) }); }
export function resetChat() {
  abort?.abort();
  state.msgs.forEach((m) => m.files?.forEach((f) => URL.revokeObjectURL(f.preview)));
  conv = crypto.randomUUID(); set({ msgs: [], busy: false }); greet();
}
/** Teks pesan + baris lampiran, persis seperti yang dibaca bot (untuk riwayat). */
const historyText = (m: Msg) => [textOf(m), ...(m.files ?? []).map(attachmentLine)].filter(Boolean).join("\n\n");
export function stopChat() { abort?.abort(); }

export async function send(raw: string, accounts: Account[], owner: boolean, files: SentFile[] = []) {
  const text = raw.trim() || (files.length ? "Tolong iklankan lampiran ini." : "");
  if (!text || state.busy) return;
  const ctxLine = () => { const v = getView(); return `${accLabel(v.acc, accounts)} · ${fmtRange(v.from, v.to)}`; };
  push({ role: "user", parts: [{ type: "text", text }], ...(files.length ? { files } : {}) });
  // Pesan berlampiran selalu ke bot (bukan konfirmasi/pindah tampilan lokal).
  const it = files.length ? {} as ReturnType<typeof parseIntent> : parseIntent(text, accounts);

  // 1) Konfirmasi "ya"/"batal" untuk kartu aksi terakhir — diproses lokal, bukan oleh AI.
  if (it.confirm) {
    const pa = [...state.msgs].reverse().find((m) => m.action?.status === "pending")?.action;
    if (pa) {
      try {
        const a = it.confirm === "yes" ? await actionsApi.confirm(pa.id) : await actionsApi.cancel(pa.id);
        updateAction(a);
        botText(a.status === "executed" ? `Beres, **${a.campaignName}** sudah dieksekusi.` : a.status === "failed" ? `Gagal: ${a.error}` : "Oke, dibatalkan.");
        refreshData();
      } catch (e) { botText((e as Error).message, { error: true }); }
      return;
    }
  }

  // 2) Pindah tampilan lokal.
  const moved = (it.acc && it.acc !== getView().acc) || it.preset;
  if (moved) setView({ ...(it.acc ? { acc: it.acc } : {}), ...(it.preset ? { preset: it.preset } : {}) });

  // 3) Ubah aturan lokal (owner).
  if (it.rule) {
    if (!owner) { botText("Hanya owner yang bisa mengubah aturan.", { error: true }); return; }
    const v = getView();
    const ids = accounts.filter((a) => a.active && (v.acc === "all" || v.acc === a.id || v.acc === a.line)).map((a) => a.id);
    const [label, f] = RULE_LABEL[it.rule.field];
    try {
      await Promise.all(ids.map((id) => api(`/accounts/${id}/settings`, { method: "PATCH", json: { [it.rule!.field]: it.rule!.value } })));
      refreshData();
      botText(`${label} untuk ${ids.length > 1 ? "semua akun terpilih" : accounts.find((a) => a.id === ids[0])?.name} sekarang **${f(it.rule.value)}**.`, { ctx: ctxLine() });
    } catch (e) { botText((e as Error).message, { error: true }); }
    return;
  }

  if (moved && !it.hasQuestion) {
    const v = getView();
    botText(`Oke, dashboard pindah ke **${accLabel(v.acc, accounts)}** · ${v.preset !== "custom" ? PRESET_LABELS[v.preset] : fmtRange(v.from, v.to)}.`);
    return;
  }

  // 4) Sisanya ke backend (Claude, atau mode aturan kalau AI belum aktif).
  set({ busy: true });
  abort = new AbortController();
  const v = getView();
  const history = state.msgs.filter((m) => textOf(m) && !m.error).slice(-13, -1).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: historyText(m).slice(0, 4000) }));
  const botId = push({ role: "bot", parts: [], ctx: ctxLine() });
  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", signal: abort.signal,
      body: JSON.stringify({ message: text, history, context: { acc: v.acc, from: v.from, to: v.to }, conversationId: conv, attachments: files.map((f) => f.id) }),
    });
    if (!res.ok || !res.body) throw new ApiError((await res.json().catch(() => ({}))).error || "Bot tidak bisa dihubungi", res.status);
    const reader = res.body.getReader(), td = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += td.decode(value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const e = JSON.parse(line.slice(5)) as ChatEvent;
        if (e.type === "text") appendText(botId, e.text);
        else if (e.type === "widget") patch(botId, (m) => ({ ...m, parts: [...m.parts, { type: "widget", widget: e.widget }] }));
        else if (e.type === "action_card") push({ role: "bot", parts: [], action: e.action });
        else if (e.type === "view") setView({ ...(e.acc ? { acc: e.acc } : {}), ...(e.preset ? { preset: e.preset } : e.from && e.to ? { preset: "custom", from: e.from, to: e.to } : {}) });
        else if (e.type === "rule_changed") refreshData();
        else if (e.type === "error") patch(botId, (m) => ({ ...m, error: !textOf(m), parts: [...m.parts, { type: "text", text: (textOf(m) ? "\n\n" : "") + e.message }] }));
      }
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") appendText(botId, textOf(state.msgs.find((m) => m.id === botId)!) ? "\n\n_(dihentikan)_" : "_(dihentikan)_");
    else patch(botId, (m) => ({ ...m, error: true, parts: [{ type: "text", text: (e as Error).message }] }));
  }
  abort = null;
  set({ busy: false, msgs: state.msgs.filter((m) => m.id !== botId || m.parts.length) });
}
