// Jembatan ke MCP resmi Meta Ads (https://mcp.facebook.com/ads) lewat JSON-RPC, tanpa LLM.
// Tekniknya sama dengan project bot_iklan_fb/hermes-ads (builder/meta_mcp.py): token OAuth dibaca dari login
// Claude Code user `claude-ads` di VPS. Token berlaku ±60 hari tanpa refresh; kalau habis, login ulang Claude Code di VPS.
import { existsSync, readFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { env } from "../env";

export class McpError extends Error {
  constructor(message: string, public code?: "auth" | "expired" | "net" | "tool") { super(message); }
}

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** ID 20 karakter (huruf besar + kecil + angka) yang diminta Meta untuk mengelompokkan panggilan satu percakapan. */
export function conversationId(): string {
  for (;;) {
    const s = Array.from({ length: 20 }, () => CHARS[randomInt(CHARS.length)]).join("");
    if (/[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s)) return s;
  }
}

export interface McpToken { accessToken: string; expiresAt: number | null }

/** Baca token Meta Ads dari file kredensial Claude Code. Melempar McpError kalau tidak ada / kedaluwarsa. */
export function readToken(): McpToken {
  let d: any;
  try { d = JSON.parse(readFileSync(env.META_MCP_CRED, "utf8")); }
  catch (e) { throw new McpError(`Kredensial Meta tidak terbaca (${env.META_MCP_CRED}): ${(e as Error).message}`, "auth"); }
  const ent = Object.values<any>(d.mcpOAuth ?? {}).find((v) => v?.serverName === "meta_ads");
  if (!ent?.accessToken) throw new McpError("Belum login Meta Ads di Claude Code VPS (user claude-ads)", "auth");
  const exp = ent.expiresAt ? Number(ent.expiresAt) : null;
  if (exp && exp < Date.now() + 60_000) throw new McpError("Token Meta Ads kedaluwarsa, login ulang Claude Code di VPS (user claude-ads)", "expired");
  return { accessToken: ent.accessToken, expiresAt: exp };
}

/** Status token tanpa melempar (untuk halaman status integrasi). */
export function tokenStatus(): { ok: boolean; expiresAt: string | null; error: string | null } {
  try {
    const t = readToken();
    return { ok: true, expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : null, error: null };
  } catch (e) {
    return { ok: false, expiresAt: null, error: (e as Error).message };
  }
}
export const mcpAvailable = () => existsSync(env.META_MCP_CRED);

const CONNECT_ATTEMPTS = 5;

/** fetch gagal SEBELUM tersambung (TCP connect/DNS), jadi permintaan belum sampai ke Meta dan aman diulang, termasuk aksi tulis. */
export function isConnectError(e: unknown): boolean {
  const c: any = (e as any)?.cause;
  if (!c) return false;
  if (c.code === "UND_ERR_CONNECT_TIMEOUT") return true;
  const errs: any[] = Array.isArray(c.errors) && c.errors.length ? c.errors : [c];
  return errs.every((x) => x?.syscall === "connect" || x?.syscall === "getaddrinfo");
}

class Client {
  private sid: string | null = null;
  private n = 0;
  private starting: Promise<void> | null = null;

  private async post(body: Record<string, unknown>): Promise<any | null> {
    const headers: Record<string, string> = {
      Authorization: "Bearer " + readToken().accessToken, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    };
    if (this.sid) { headers["Mcp-Session-Id"] = this.sid; headers["Mcp-Protocol-Version"] = "2025-06-18"; }
    let res: Response;
    for (let attempt = 1; ; attempt++) {
      try { res = await fetch(env.META_MCP_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(150_000) }); break; }
      catch (e) {
        // Dari VPS 3 ±20% koneksi baru ke edge Meta hilang di jaringan; koneksi berikutnya (port sumber lain) biasanya lancar.
        if (isConnectError(e) && attempt < CONNECT_ATTEMPTS) { await new Promise((r) => setTimeout(r, 300 * attempt)); continue; }
        throw new McpError(`Koneksi ke Meta gagal: ${(e as Error).message}${attempt > 1 ? ` (setelah ${attempt}x coba)` : ""}`, "net");
      }
    }
    this.sid = res.headers.get("mcp-session-id") ?? this.sid;
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      if (res.status === 401) throw new McpError("Token Meta Ads ditolak (401), login ulang Claude Code di VPS", "auth");
      const e = new McpError(`HTTP ${res.status} dari Meta: ${detail}`, "net");
      (e as any).status = res.status;
      throw e;
    }
    if (!("id" in body)) return null;
    const raw = await res.text();
    if ((res.headers.get("content-type") ?? "").includes("event-stream")) {
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const m = JSON.parse(line.slice(5));
        if (m.id === body.id) return m;
      }
      throw new McpError("Respons SSE Meta tanpa hasil", "net");
    }
    return JSON.parse(raw);
  }

  private async rpc(method: string, params?: unknown) {
    const id = ++this.n;
    const m = await this.post({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    if (m?.error) throw new McpError(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`, "tool");
    return m!.result;
  }

  private init() {
    return (this.starting ??= (async () => {
      this.sid = null;
      await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dashboard-iklan", version: "1.0" } });
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    })().finally(() => { this.starting = null; }));
  }

  async call(tool: string, args: Record<string, unknown>): Promise<any> {
    let res: any;
    for (let attempt = 0; ; attempt++) {
      try {
        if (!this.sid) await this.init();
        res = await this.rpc("tools/call", { name: tool, arguments: args });
        break;
      } catch (e) {
        const st = (e as any).status;
        const retryable = e instanceof McpError && (e.code === "net") && attempt === 0;
        if (retryable || ((st === 400 || st === 404) && attempt === 0)) { this.sid = null; continue; }
        throw e;
      }
    }
    const text = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    let data = res.structuredContent;
    if (data == null) { try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; } }
    if (res.isError) throw new McpError(text.trim() || JSON.stringify(data).slice(0, 800), "tool");
    return data;
  }
}

const client = new Client();

/** Panggil satu tool Meta; `job`/`request` wajib diisi Meta untuk pelaporan penggunaan. */
export function callTool(tool: string, args: Record<string, unknown>, ctx: { conv?: string; job?: string; request?: string } = {}) {
  return client.call(tool, {
    client_conversation_id: ctx.conv ?? conversationId(),
    advertiser_job: ctx.job ?? "report_measure_or_look_up",
    advertiser_request: (ctx.request ?? "laporan performa iklan").slice(0, 500),
    ...args,
  });
}

/** Beberapa field respons Meta berupa string JSON; buka kalau perlu. */
export function unwrap<T = any>(x: unknown): T {
  if (typeof x === "string" && /^\s*[\[{]/.test(x)) { try { return JSON.parse(x); } catch { /* biarkan */ } }
  return x as T;
}

/** Angka dari Meta bisa berbentuk 12, "12", "3,45%", {"value":"934","unit":"IDR"}, {"values":[...]}. */
export function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "object") {
    const o = v as any;
    if (Array.isArray(o.values)) return o.values.reduce((t: number, x: unknown) => t + num(x), 0);
    return num(o.value);
  }
  if (typeof v === "number") return v;
  let s = String(v).trim().replace("%", "");
  if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
export const rupiah = (v: unknown) => Math.round(num(v));

/** Ambil semua halaman ads_get_ad_entities (cursor dari pagination.next_cursor; parameter lain dikirim ulang persis). */
export async function getEntities(args: Record<string, unknown>, ctx?: Parameters<typeof callTool>[2], maxPages = 20): Promise<any[]> {
  const conv = ctx?.conv ?? conversationId();
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const r = await callTool("ads_get_ad_entities", { include_additional_context: false, ...args, ...(cursor ? { cursor } : {}) }, { ...ctx, conv });
    out.push(...(unwrap<any[]>(r.ad_entities) ?? []));
    cursor = r.pagination?.next_cursor ?? undefined;
    if (!cursor) break;
  }
  return out;
}
