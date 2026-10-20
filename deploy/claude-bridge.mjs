#!/usr/bin/env node
// Jembatan Claude Code untuk bot dashboard. Berjalan di host VPS sebagai user claude-ads (login Claude + langganan),
// listen hanya di gateway jaringan Docker. Tiap pertanyaan menjalankan `claude -p` tanpa tool bawaan (tanpa Bash/file/web);
// satu-satunya tool adalah server MCP dashboard (/internal/mcp) dengan token sekali pakai dari dashboard.
// Respons berupa NDJSON: {t:"text",v} | {t:"break"} | {t:"done",usage} | {t:"error",v}.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";

const HOST = process.env.BRIDGE_HOST || "10.0.1.1";
const PORT = Number(process.env.BRIDGE_PORT || 8790);
const TOKEN = process.env.BRIDGE_TOKEN || "";
const CLAUDE = process.env.CLAUDE_BIN || `${process.env.HOME}/.local/bin/claude`;
const MAX_CONCURRENT = Number(process.env.BRIDGE_MAX_CONCURRENT || 2);
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 170_000);
const WORKDIR = process.env.BRIDGE_WORKDIR || `${process.env.HOME}/bridge-cwd`; // folder kosong: tanpa CLAUDE.md/proyek
if (TOKEN.length < 24) { console.error("BRIDGE_TOKEN wajib (min. 24 karakter)"); process.exit(1); }
mkdirSync(WORKDIR, { recursive: true });

let running = 0;
const authed = (h) => {
  const got = Buffer.from(String(h || "").replace(/^Bearer\s+/i, "")), want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
};
const readBody = (req, limit = 256 * 1024) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("terlalu besar")); req.destroy(); } else chunks.push(c); });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

function runClaude({ model, system, prompt, mcpUrl, mcpToken }, res, req) {
  const mcp = { mcpServers: { dashboard: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${mcpToken}` } } } };
  const args = [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--model", model, "--system-prompt", system,
    "--tools", "", "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp), "--allowedTools", "mcp__dashboard",
    "--no-session-persistence",
  ];
  const child = spawn(CLAUDE, args, {
    cwd: WORKDIR, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
  });
  const send = (o) => { if (!res.writableEnded) res.write(JSON.stringify(o) + "\n"); };
  let buf = "", sawText = false, finished = false, stderr = "";
  const finish = (o) => { if (finished) return; finished = true; if (o) send(o); res.end(); };
  const timer = setTimeout(() => { child.kill("SIGTERM"); finish({ t: "error", v: "Claude terlalu lama menjawab (timeout)" }); }, TIMEOUT_MS);

  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === "stream_event") {
        const e = m.event || {};
        if (e.type === "message_start" && sawText) send({ t: "break" });
        else if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) { sawText = true; send({ t: "text", v: e.delta.text }); }
      } else if (m.type === "result") {
        const u = m.usage || {};
        if (m.is_error && !sawText) finish({ t: "error", v: String(m.result || m.subtype || "Claude gagal") });
        else finish({ t: "done", usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 } });
      }
    }
  });
  child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
  child.on("error", (e) => finish({ t: "error", v: `Gagal menjalankan Claude: ${e.message}` }));
  child.on("close", (code) => {
    clearTimeout(timer); running--;
    if (!finished) finish(code === 0 ? { t: "done", usage: { input: 0, output: 0, cacheRead: 0 } } : { t: "error", v: `Claude berhenti (kode ${code}). ${stderr.split("\n").filter(Boolean).pop() || ""}`.trim() });
  });
  // Dashboard memutus koneksi (user menutup chat) → hentikan proses supaya tidak memakan RAM/kuota.
  res.on("close", () => { if (!finished) child.kill("SIGTERM"); });
  child.stdin.end(prompt);
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, running, max: MAX_CONCURRENT }));
  if (req.method !== "POST" || req.url !== "/v1/chat") return res.writeHead(404).end();
  if (!authed(req.headers.authorization)) return res.writeHead(401).end();
  if (running >= MAX_CONCURRENT) return res.writeHead(429).end();
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return res.writeHead(400).end(); }
  const ok = ["model", "system", "prompt", "mcpUrl", "mcpToken"].every((k) => typeof body[k] === "string" && body[k].length);
  if (!ok || !/^http:\/\/127\.0\.0\.1:\d+\/internal\/mcp$/.test(body.mcpUrl)) return res.writeHead(400).end();
  running++;
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  runClaude(body, res, req);
}).listen(PORT, HOST, () => console.log(`claude-bridge listen ${HOST}:${PORT}, maks ${MAX_CONCURRENT} proses`));
