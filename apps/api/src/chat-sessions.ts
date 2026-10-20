// Token sekali pakai per pesan chat. Claude Code (lewat jembatan di host) memanggil tool dashboard di /internal/mcp
// dengan token ini, jadi tool berjalan sebagai user & konteks tampilan yang benar, dan event (widget, kartu aksi)
// langsung masuk ke stream SSE pesan itu. Token mati saat pesan selesai atau setelah 5 menit.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ChatEvent, User } from "@iklan/shared";

export interface ChatSession { user: User; ctx: { acc: string; from: string; to: string }; emit: (e: ChatEvent) => void; expires: number }

const TTL_MS = 5 * 60_000;
const sessions = new Map<string, ChatSession>();

export function openChatSession(s: Omit<ChatSession, "expires">): string {
  for (const [k, v] of sessions) if (v.expires < Date.now()) sessions.delete(k);
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { ...s, expires: Date.now() + TTL_MS });
  return token;
}

export function getChatSession(token: string | undefined): ChatSession | null {
  if (!token) return null;
  for (const [k, v] of sessions) {
    const a = Buffer.from(k), b = Buffer.from(token);
    if (a.length === b.length && timingSafeEqual(a, b)) return v.expires >= Date.now() ? v : (sessions.delete(k), null);
  }
  return null;
}

export const closeChatSession = (token: string) => void sessions.delete(token);
