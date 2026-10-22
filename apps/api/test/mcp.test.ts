import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Server MCP tiruan: meniru protokol mcp.facebook.com/ads (initialize → tools/call, balasan JSON atau SSE).
const calls: { auth?: string; sid?: string; method: string; tool?: string; args?: any }[] = [];
let sessions = 0, drop404Once = false;
let server: Server;
const dir = mkdtempSync(path.join(tmpdir(), "mcp-test-"));
const credFile = path.join(dir, "cred.json");
const writeCred = (expiresAt: number | null, name = "meta_ads") =>
  writeFileSync(credFile, JSON.stringify({ mcpOAuth: { x: { serverName: name, accessToken: "tok-123", expiresAt } } }));

beforeAll(async () => {
  server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const m = JSON.parse(b);
      calls.push({ auth: req.headers.authorization, sid: req.headers["mcp-session-id"] as string, method: m.method, tool: m.params?.name, args: m.params?.arguments });
      if (m.method === "notifications/initialized") { res.writeHead(202).end(); return; }
      if (m.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-" + ++sessions }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }));
        return;
      }
      if (drop404Once && req.headers["mcp-session-id"]) { drop404Once = false; res.writeHead(404).end("session expired"); return; }
      const page = {
        ad_entities: JSON.stringify([{ id: "1", name: "A", date_start: "2026-10-01", amount_spent: { value: "1500", unit: "IDR" } }]),
        pagination: m.params.arguments.cursor ? undefined : { next_cursor: "p2" },
      };
      let out: any = { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(page) }] } };
      if (m.params.name === "ads_error") out = { jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "akun tidak aktif" }] } };
      if (m.params.arguments.cursor || m.params.name === "ads_sse")
        res.writeHead(200, { "content-type": "text/event-stream" }).end("event: message\ndata: " + JSON.stringify(out) + "\n\n");
      else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.DATABASE_URL = "postgres://x@localhost/x";
  process.env.META_MCP_CRED = credFile;
  process.env.META_MCP_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  writeCred(Date.now() + 86400_000);
});
afterAll(() => server.close());

describe("klien MCP Meta", () => {
  it("membaca token dari file kredensial Claude Code", async () => {
    const m = await import("../src/meta/mcp");
    expect(m.readToken().accessToken).toBe("tok-123");
    expect(m.tokenStatus().ok).toBe(true);
    writeCred(Date.now() - 1000);
    expect(() => m.readToken()).toThrow(/kedaluwarsa/);
    expect(m.tokenStatus()).toMatchObject({ ok: false });
    writeCred(Date.now() + 86400_000, "server_lain");
    expect(() => m.readToken()).toThrow(/Belum login/);
    writeCred(Date.now() + 86400_000);
  });

  it("initialize → tools/call dengan Bearer token & session id, paging lewat cursor, SSE & JSON", async () => {
    const m = await import("../src/meta/mcp");
    calls.length = 0;
    const rows = await m.getEntities({ ad_account_id: "123", level: "campaign" });
    expect(rows).toHaveLength(2); // halaman 1 (JSON) + halaman 2 (SSE)
    expect(calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
    expect(calls.every((c) => c.auth === "Bearer tok-123")).toBe(true);
    expect(calls[2].sid).toBe("sess-1");
    expect(calls[2].tool).toBe("ads_get_ad_entities");
    expect(calls[2].args).toMatchObject({ ad_account_id: "123", level: "campaign", advertiser_job: "report_measure_or_look_up", include_additional_context: false });
    expect(calls[2].args.client_conversation_id).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(calls[3].args.cursor).toBe("p2");
    expect(calls[3].args.client_conversation_id).toBe(calls[2].args.client_conversation_id); // satu percakapan
  });

  it("sesi kedaluwarsa (404) → buka sesi baru lalu ulangi", async () => {
    const m = await import("../src/meta/mcp");
    calls.length = 0; drop404Once = true;
    const r = await m.callTool("ads_sse", {});
    expect(r.ad_entities).toBeTruthy();
    expect(calls.filter((c) => c.method === "initialize")).toHaveLength(1);
    expect(sessions).toBeGreaterThanOrEqual(2);
  });

  it("error tool Meta dilempar apa adanya", async () => {
    const m = await import("../src/meta/mcp");
    await expect(m.callTool("ads_error", {})).rejects.toThrow("akun tidak aktif");
  });

  it("parser angka Meta & ID percakapan", async () => {
    const { num, rupiah, conversationId } = await import("../src/meta/mcp");
    expect(num({ value: "934", unit: "IDR" })).toBe(934);
    expect(num("3,45%")).toBe(3.45);
    expect(num({ values: [1, "2", { value: 3 }] })).toBe(6);
    expect(num(null)).toBe(0);
    expect(num("Not available")).toBe(0);
    expect(rupiah({ value: "1089313" })).toBe(1089313);
    for (let i = 0; i < 50; i++) expect(conversationId()).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)[A-Za-z0-9]{20}$/);
  });
});

describe("parser respons asli Meta → baris DB", () => {
  const load = (f: string) => JSON.parse(readFileSync(path.join(__dirname, "fixtures", f), "utf8"));
  it("harian per kampanye", async () => {
    const { parseDailyRows } = await import("../src/meta/sync");
    const rows = load("real-daily.json");
    const { campaigns, daily } = parseDailyRows(rows, "digital");
    expect(daily.length).toBeGreaterThan(5);
    expect(daily.every((d) => Number.isInteger(d.spend) && d.spend >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(d.date))).toBe(true);
    expect(daily.some((d) => !d.spend && !d.impressions && !d.clicks && !d.purchases)).toBe(false); // baris kosong dibuang
    expect(new Set(campaigns.map((c) => c.id)).size).toBe(campaigns.length);
    const sumRaw = rows.reduce((t: number, e: any) => t + Math.round(Number(e.amount_spent.value)), 0);
    expect(daily.reduce((t, d) => t + d.spend, 0)).toBe(sumRaw);
    expect(daily.every((d) => d.leads === 0)).toBe(true); // akun digital tidak menghitung leads
  });
  it("per jam: baris 'null' dilewati", async () => {
    const { parseHourlyRows } = await import("../src/meta/sync");
    const rows = load("real-hourly.json");
    const out = parseHourlyRows(rows, "digital");
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((h) => h.hour >= 0 && h.hour <= 23)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(rows.length - 2);
  });
  it("leads jasa dari field lead atau results pesan", async () => {
    const { leadsOf } = await import("../src/meta/sync");
    expect(leadsOf({ lead: "4" }, "jasa")).toBe(4);
    expect(leadsOf({ results: { indicator: "actions:onsite_conversion.messaging_conversation_started_7d", values: [{ value: "7" }] } }, "jasa")).toBe(7);
    expect(leadsOf({ results: { indicator: "actions:omni_purchase", values: [{ value: "9" }] } }, "jasa")).toBe(0);
    expect(leadsOf({ lead: "4" }, "digital")).toBe(0);
  });
});

describe("koneksi ke Meta", () => {
  const errOf = (p: Promise<unknown>) => p.then(() => null, (e) => e);
  it("gagal tersambung (permintaan belum terkirim) boleh diulang", async () => {
    const { isConnectError } = await import("../src/meta/mcp");
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as any).port;
    await new Promise((r) => closed.close(r));
    expect(isConnectError(await errOf(fetch(`http://127.0.0.1:${port}/`)))).toBe(true);
    // Format error AggregateError dari happy eyeballs (IPv4 timeout + IPv6 unreachable) di VPS 3.
    const agg = Object.assign(new AggregateError([
      Object.assign(new Error("connect ETIMEDOUT 57.144.24.141:443"), { code: "ETIMEDOUT", syscall: "connect" }),
      Object.assign(new Error("connect ENETUNREACH 2a03:2880::2:443"), { code: "ENETUNREACH", syscall: "connect" }),
    ]), { code: "ETIMEDOUT" });
    expect(isConnectError(new TypeError("fetch failed", { cause: agg }))).toBe(true);
  });
  it("putus setelah permintaan terkirim TIDAK diulang (bisa dobel aksi tulis)", async () => {
    const { isConnectError } = await import("../src/meta/mcp");
    const rude = createServer((req) => req.socket.destroy());
    await new Promise<void>((r) => rude.listen(0, "127.0.0.1", r));
    const e = await errOf(fetch(`http://127.0.0.1:${(rude.address() as any).port}/`, { method: "POST", body: "{}" }));
    await new Promise((r) => rude.close(r));
    expect(e).toBeInstanceOf(Error);
    expect(isConnectError(e)).toBe(false);
    expect(isConnectError(new Error("tanpa cause"))).toBe(false);
  });
});
