import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { ChatEvent, Kpis } from "@iklan/shared";
import { summaryWidgets, campaignsWidget } from "../src/chat-widgets";
import { mcpHandler } from "../src/mcp-server";
import { openChatSession, closeChatSession } from "../src/chat-sessions";

const k = (o: Partial<Kpis>): Kpis => ({
  days: 7, spend: 0, impr: 0, clicks: 0, leads: 0, results: 0, metaRev: 0, revenue: 0, orders: 0, jasaOrders: 0, fee: 0, cogs: 0, gross: 0,
  adTax: 0, fixed: 0, other: 0, net: 0, roas: 0, metaRoas: 0, cpa: 0, cpl: 0, closeRate: 0, ctr: 0, cpc: 0, aov: 0, margin: 0, netMargin: 0,
  beRoas: 0, profitPerOrder: 0, maxCpaBE: 0, ...o,
});

describe("chat widgets", () => {
  it("ringkasan: KPI dengan pembanding + progress ROAS vs impas", () => {
    const w = summaryWidgets("Semua akun", "14–20 Okt 2026", "7–13 Okt 2026", k({ net: 1250000.4, revenue: 3087000, spend: 1600000, roas: 1.929, beRoas: 1.4, orders: 63, cpa: 25397 }), k({ net: 500000, revenue: 1274000, spend: 900000, roas: 1.41 }));
    expect(w).toHaveLength(2);
    const kpis = w[0];
    if (kpis.kind !== "kpis") throw new Error("kpis");
    expect(kpis.items.find((x) => x.label === "Laba bersih")).toMatchObject({ value: 1250000, prev: 500000, format: "rp", upIsGood: true });
    expect(kpis.items.find((x) => x.label === "Spend iklan")?.upIsGood).toBe(false);
    expect(kpis.items.some((x) => x.label === "CPA")).toBe(true);
    expect(w[1]).toMatchObject({ kind: "progress", items: [{ value: 1.93, target: 1.4, format: "x" }] });
  });
  it("lini jasa menampilkan CPL, bukan CPA; tanpa spend tidak ada progress", () => {
    const w = summaryWidgets("Akun Jasa", "p", "c", k({ leads: 12, cpl: 41000 }), k({}));
    expect(w).toHaveLength(1);
    if (w[0].kind !== "kpis") throw new Error("kpis");
    expect(w[0].items.map((x) => x.label)).toContain("CPL");
    expect(w[0].items.map((x) => x.label)).not.toContain("CPA");
  });
  it("kampanye tanpa spend tidak menghasilkan widget", () => {
    expect(campaignsWidget("x", "p", [])).toBeNull();
  });
});

describe("server MCP internal", () => {
  const app = new Hono().post("/internal/mcp", mcpHandler);
  const rpc = (body: unknown, token?: string) => app.request("/internal/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });

  it("menolak tanpa token / token salah", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "salah")).status).toBe(401);
  });
  it("initialize, server/discover, tools/list, notifikasi; token mati setelah ditutup", async () => {
    const events: ChatEvent[] = [];
    const t = openChatSession({ user: { id: 1, email: "o@x", name: "O", role: "owner" }, ctx: { acc: "all", from: "2026-10-14", to: "2026-10-20" }, emit: (e) => events.push(e) });
    const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, t)).json();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect((await (await rpc({ jsonrpc: "2.0", id: 2, method: "server/discover" }, t)).json()).result).toEqual({});
    const list = await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, t)).json();
    const names = list.result.tools.map((x: any) => x.name);
    expect(names).toEqual(expect.arrayContaining(["get_summary", "get_campaigns", "propose_campaign_action"]));
    expect(list.result.tools[0].inputSchema.type).toBe("object");
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, t)).status).toBe(202);
    closeChatSession(t);
    expect((await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, t)).status).toBe(401);
  });
});
