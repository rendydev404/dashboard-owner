// Server MCP internal (Streamable HTTP, respons JSON) berisi tool dashboard untuk Claude Code di host.
// Hanya menerima token sesi chat yang sedang aktif (chat-sessions.ts); Caddy juga menolak /internal/* dari luar.
import type { Context } from "hono";
import { TOOLS, runTool } from "./bot";
import { getChatSession } from "./chat-sessions";
import { errMsg, log } from "./log";

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

export async function mcpHandler(c: Context) {
  const session = getChatSession(c.req.header("authorization")?.replace(/^Bearer\s+/i, ""));
  if (!session) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Sesi chat tidak valid atau sudah selesai" } }, 401);

  let body: Rpc | Rpc[];
  try { body = await c.req.json(); } catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON tidak valid" } }, 400); }

  const handle = async (m: Rpc) => {
    if (m.id === undefined || m.id === null) return null; // notifikasi: tidak dibalas
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize":
        return ok({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "dashboard-owner", version: "1.0.0" } });
      case "ping":
      case "server/discover": // dikirim Claude Code sebelum initialize
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        let out: unknown;
        try { out = await runTool(name, m.params?.arguments ?? {}, session.ctx, session.user, session.emit); }
        catch (e) { log.error("tool chat gagal", { tool: name, error: errMsg(e) }); out = { error: errMsg(e) }; }
        const imgs = Array.isArray((out as any)?.__images) ? ((out as any).__images as { mimeType: string; data: string }[]) : [];
        const clean = imgs.length && out && typeof out === "object" ? Object.fromEntries(Object.entries(out as Record<string, unknown>).filter(([k]) => k !== "__images")) : out;
        return ok({
          content: [
            ...imgs.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType })),
            { type: "text", text: JSON.stringify(clean) },
          ],
          isError: !!(clean as any)?.error,
        });
      }
      default:
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Metode tidak dikenal: ${m.method}` } };
    }
  };

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter(Boolean);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const out = await handle(body);
  return out ? c.json(out) : c.body(null, 202);
}
