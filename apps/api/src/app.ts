import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { secureHeaders } from "hono/secure-headers";
import { compress } from "hono/compress";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import {
  type Bootstrap, type ManualItem, type ChatEvent, type ServerEvent,
  parseRp, isDateKey, todayKey, hourNow, DEFAULT_SETTINGS, attachmentLine,
} from "@iklan/shared";
import { sql, dataVersion, bumpDataVersion } from "./db";
import { env, metaConfigured, metaMode, aiConfigured, lynkConfigured } from "./env";
import { tokenStatus } from "./meta/mcp";
import {
  type AppEnv, requireAuth, requireRole, createSession, destroySession, verifyPassword, hashPassword,
  rateLimit, clientIp, sameOrigin, forgetSession,
} from "./auth";
import { loadConfig, resolveRange, resolveScope } from "./scope";
import { cached } from "./cache";
import * as Q from "./queries";
import { fbAds, lynkStats } from "./queries-tabs";
import { handleLynkWebhook } from "./lynk";
import { createCampaignAction, confirmAction, cancelAction, revertAction, listActions, getAction } from "./actions";
import { handleChat, updateRule } from "./bot";
import { MEDIA_LIMITS, MediaError, attachmentOf, getMedia, openByToken, removeMedia, saveMedia } from "./media";
import { mcpHandler } from "./mcp-server";
import { runSync, lastMetaError, fetchAccountInfo } from "./meta/sync";
import { subscribe } from "./events";
import { log, errMsg } from "./log";

export const app = new Hono<AppEnv>();

app.use("*", secureHeaders({
  contentSecurityPolicy: {
    // blob: = pratinjau lokal lampiran foto/video di chat (object URL, tidak dikirim ke mana pun).
    defaultSrc: ["'self'"], imgSrc: ["'self'", "data:", "blob:"], mediaSrc: ["'self'", "blob:"], connectSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'"], fontSrc: ["'self'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
  },
  crossOriginEmbedderPolicy: false,
}));
app.use("/api/*", async (c, next) => { c.header("X-Robots-Tag", "noindex, nofollow"); await next(); });
// SSE (/api/events, /api/chat) tidak dikompres supaya event langsung terkirim.
app.use("/api/*", async (c, next) => (c.req.path === "/api/events" || c.req.path === "/api/chat" ? next() : compress()(c, next)));
app.use("/api/*", sameOrigin);

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  if (err instanceof MediaError) return c.json({ error: err.message }, err.status);
  if (err instanceof z.ZodError) return c.json({ error: "Input tidak valid", details: err.flatten().fieldErrors }, 400);
  log.error("unhandled", { path: c.req.path, error: errMsg(err) });
  return c.json({ error: "Terjadi kesalahan di server" }, 500);
});

/* ---------------------------------------------------------------- publik */

app.get("/healthz", async (c) => {
  try {
    const [r] = await sql`SELECT extract(epoch FROM now() - max(finished_at))::int / 60 AS age FROM sync_runs WHERE status = 'ok'`;
    return c.json({ ok: true, db: true, lastSyncAgeMin: r?.age ?? null });
  } catch {
    return c.json({ ok: false, db: false }, 503);
  }
});

app.post("/webhooks/lynk", rateLimit(120, 60_000, clientIp), async (c) => {
  const raw = await c.req.text();
  if (raw.length > 64_000) return c.json({ ok: false, error: "Payload terlalu besar" }, 413);
  const res = await handleLynkWebhook(raw, c.req.header("x-lynk-signature"));
  return c.json(res.body, res.status);
});

// Pengunduh media Meta mematuhi robots.txt: hanya /m/ (lampiran sementara) yang boleh diambil, sisanya tertutup.
app.get("/robots.txt", (c) => c.text("User-agent: *\nAllow: /m/\nDisallow: /\n", 200, { "Cache-Control": "public, max-age=3600" }));

// Link publik sementara lampiran chat, diunduh Meta saat upload media iklan. Token acak 192-bit, mati setelah file
// diterima Meta / 2 jam. Tanpa cookie karena yang mengakses server Meta.
app.on(["GET", "HEAD"], "/m/:token/:name?", rateLimit(120, 60_000, clientIp), (c) => {
  const f = openByToken(c.req.param("token"));
  if (!f) return c.text("Tidak ditemukan", 404);
  const { entry: e } = f;
  log.info("lampiran diunduh", { id: e.id, ua: (c.req.header("user-agent") ?? "").slice(0, 80) });
  const headers = {
    "Content-Type": e.mime, "Content-Length": String(e.size), "Cache-Control": "private, no-store",
    "Content-Disposition": `inline; filename="${e.name}"`,
  };
  if (c.req.method === "HEAD") return c.body(null, 200, headers);
  return c.body(Readable.toWeb(f.stream()) as ReadableStream, 200, headers);
});

/* ---------------------------------------------------------------- auth */

const loginLimiter = rateLimit(5, 15 * 60_000, (c) => "login:" + clientIp(c));
app.post("/api/auth/login", loginLimiter, async (c) => {
  const body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).parse(await c.req.json());
  const [u] = await sql`SELECT id, password_hash FROM users WHERE lower(email) = lower(${body.email})`;
  if (!u || !(await verifyPassword(u.password_hash, body.password))) throw new HTTPException(401, { message: "Email atau password salah" });
  await createSession(c, Number(u.id));
  return c.json({ ok: true });
});
app.post("/api/auth/logout", async (c) => {
  forgetSession(c);
  await destroySession(c);
  return c.json({ ok: true });
});

const api = new Hono<AppEnv>();
api.use("*", requireAuth);
const owner = requireRole("owner");

api.get("/auth/me", (c) => c.json(c.get("user")));

/* ---------------------------------------------------------------- data */

/** ETag dari versi data: request ulang tanpa perubahan dijawab 304 tanpa body. */
function etag(c: Context) {
  const tag = `W/"${dataVersion()}-${Buffer.from(c.req.url).toString("base64url").slice(-24)}"`;
  c.header("ETag", tag);
  c.header("Cache-Control", "private, no-cache");
  return c.req.header("if-none-match") === tag;
}
function rq(c: Context) {
  return { acc: c.req.query("acc"), from: c.req.query("from"), to: c.req.query("to"), preset: c.req.query("preset") };
}

async function integration() {
  const [last] = await sql`SELECT finished_at, status FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`;
  const [lynk] = await sql`SELECT max(received_at) AS at FROM lynk_events WHERE signature_ok`;
  return {
    metaConfigured: metaConfigured(), metaMode: metaMode(), metaError: lastMetaError ?? (metaMode() === "mcp" ? tokenStatus().error : null),
    metaTokenExpiresAt: metaMode() === "mcp" ? tokenStatus().expiresAt : null,
    lastSyncAt: last?.finished_at?.toISOString() ?? null, lastSyncStatus: last?.status ?? null,
    lynkConfigured: lynkConfigured(), lastLynkAt: lynk?.at?.toISOString() ?? null, aiConfigured: aiConfigured(),
  };
}

api.get("/bootstrap", async (c) => {
  const [cfg, integ] = await Promise.all([loadConfig(), cached("integration", integration)]);
  const body: Bootstrap = {
    user: c.get("user"), today: todayKey(), hourNow: hourNow(), dataVersion: dataVersion(),
    accounts: cfg.accounts, products: cfg.products, fixedCosts: cfg.fixedCosts, lineSettings: cfg.lineSettings, integration: integ,
  };
  c.header("Cache-Control", "private, no-store");
  return c.json(body);
});

const aggregate = (name: string, fn: (q: ReturnType<typeof rq>) => Promise<unknown>) =>
  api.get(`/${name}`, async (c) => {
    if (etag(c)) return c.body(null, 304);
    const q = rq(c);
    return c.json(await cached(`${name}|${q.acc}|${q.from}|${q.to}|${q.preset}`, () => fn(q)));
  });

aggregate("dashboard", async (q) => { const cfg = await loadConfig(); return Q.dashboard(resolveScope(q.acc, cfg), resolveRange(q.from, q.to, q.preset), cfg); });
aggregate("campaigns", async (q) => { const cfg = await loadConfig(); return Q.campaigns(resolveScope(q.acc, cfg), resolveRange(q.from, q.to, q.preset)); });
aggregate("hourly", async (q) => { const cfg = await loadConfig(); return Q.hourly(resolveScope(q.acc, cfg), resolveRange(q.from, q.to, q.preset)); });
aggregate("products", async (q) => { const cfg = await loadConfig(); return Q.products(resolveScope(q.acc, cfg), resolveRange(q.from, q.to, q.preset)); });
aggregate("fb", async (q) => { const cfg = await loadConfig(); return fbAds(resolveScope(q.acc, cfg), resolveRange(q.from, q.to, q.preset)); });
aggregate("lynk", async (q) => lynkStats(resolveRange(q.from, q.to, q.preset), await loadConfig()));
aggregate("pl", async (q) =>Q.pl(resolveRange(q.from, q.to, q.preset), await loadConfig()));

api.get("/export/campaigns.csv", async (c) => {
  const q = rq(c), cfg = await loadConfig(), r = resolveRange(q.from, q.to, q.preset);
  const data = await Q.campaigns(resolveScope(q.acc, cfg), r);
  const head = ["Akun", "Kampanye", "Status", "Spend", "Impresi", "Klik", "CTR", "Leads", "Beli/closing", "CPA", "Revenue", "ROAS", "Rekomendasi"];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = data.rows.map((x) => [x.accountName, x.name, x.status, x.spend, x.impressions, x.clicks, (x.ctr * 100).toFixed(2), x.leads, x.purchases,
    x.cpa ? Math.round(x.cpa) : "", x.revenue, x.roas.toFixed(2), x.rec.label].map(esc).join(","));
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="laporan-iklan-${q.acc || "all"}-${r.from}_${r.to}.csv"`);
  return c.body("﻿" + [head.map(esc).join(","), ...lines].join("\r\n"));
});

/* ---------------------------------------------------------------- input manual */

const money = z.union([z.string(), z.number()]).transform((v) => (typeof v === "number" ? Math.round(v) : parseRp(v)));
const dateStr = z.string().refine(isDateKey, "Tanggal tidak valid").refine((d) => d <= todayKey(), "Tanggal tidak boleh di masa depan");

api.post("/sales", async (c) => {
  const b = z.object({
    date: dateStr,
    accountId: z.string().nullable().optional(),
    product: z.string().trim().min(1).max(200),
    client: z.string().trim().max(200).optional().default(""),
    source: z.enum(["iklan", "organik", "referral"]).default("iklan"),
    revenue: money.refine((v) => v > 0, "Nilai deal wajib diisi"),
    cogs: z.union([z.string(), z.number(), z.null()]).optional(),
  }).parse(await c.req.json());
  const cfg = await loadConfig();
  if (b.accountId && !cfg.accounts.some((a) => a.id === b.accountId && a.line === "jasa")) throw new HTTPException(400, { message: "Akun jasa tidak dikenal" });
  const prod = cfg.products.find((p) => p.line === "jasa" && p.name.toLowerCase() === b.product.toLowerCase());
  const cogsInput = b.cogs == null || String(b.cogs).trim() === "" ? null : typeof b.cogs === "number" ? Math.round(b.cogs) : parseRp(b.cogs);
  const [row] = await sql`
    INSERT INTO sales (line, account_id, product_id, product_name, date, occurred_at, qty, revenue, cogs, client, source, channel, created_by)
    VALUES ('jasa', ${b.accountId ?? null}, ${prod?.id ?? null}, ${prod?.name ?? b.product}, ${b.date},
            (${b.date}::date + time '12:00') AT TIME ZONE 'Asia/Jakarta', 1, ${b.revenue}, ${cogsInput ?? prod?.cogs ?? 0},
            ${b.client || null}, ${b.source}, 'manual', ${c.get("user").id})
    RETURNING id`;
  await bumpDataVersion();
  return c.json({ id: Number(row.id) }, 201);
});

api.post("/costs", async (c) => {
  const b = z.object({
    date: dateStr, line: z.enum(["digital", "jasa"]), name: z.string().trim().min(1).max(200),
    amount: money.refine((v) => v > 0, "Jumlah wajib diisi"),
  }).parse(await c.req.json());
  const [row] = await sql`
    INSERT INTO manual_costs (line, date, name, amount, created_by) VALUES (${b.line}, ${b.date}, ${b.name}, ${b.amount}, ${c.get("user").id})
    RETURNING id`;
  await bumpDataVersion();
  return c.json({ id: Number(row.id) }, 201);
});

for (const [route, table] of [["sales", "sales"], ["costs", "manual_costs"]] as const) {
  const toggle = (restore: boolean) => async (c: Context<AppEnv>) => {
    const id = Number(c.req.param("id")), u = c.get("user");
    const res = await sql`
      UPDATE ${sql(table)} SET deleted_at = ${restore ? null : sql`now()`}
      WHERE id = ${id} ${table === "sales" ? sql`AND channel = 'manual'` : sql``}
        AND (${u.role === "owner"} OR created_by = ${u.id})
      RETURNING id`;
    if (!res.length) throw new HTTPException(404, { message: "Data tidak ditemukan atau bukan milik kamu" });
    await bumpDataVersion();
    return c.json({ ok: true });
  };
  api.delete(`/${route}/:id{[0-9]+}`, toggle(false));
  api.post(`/${route}/:id{[0-9]+}/restore`, toggle(true));
}

api.get("/manual", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") || 25), 100);
  const cursor = c.req.query("cursor") || null; // created_at (teks presisi mikrodetik dari DB)
  const rows = await sql`
    (SELECT 'sale' AS kind, s.id, s.date::text AS date, s.line, s.product_name AS title, s.revenue AS amount, s.cogs, s.client, s.source,
            a.display_name AS account_name, s.created_at, s.created_at::text AS cur
     FROM sales s LEFT JOIN ad_accounts a ON a.id = s.account_id
     WHERE s.channel = 'manual' AND s.deleted_at IS NULL AND (${cursor}::timestamptz IS NULL OR s.created_at < ${cursor}::timestamptz)
     ORDER BY s.created_at DESC, s.id DESC LIMIT ${limit + 1})
    UNION ALL
    (SELECT 'cost', m.id, m.date::text, m.line, m.name, m.amount, NULL, NULL, NULL, NULL, m.created_at, m.created_at::text
     FROM manual_costs m
     WHERE m.deleted_at IS NULL AND (${cursor}::timestamptz IS NULL OR m.created_at < ${cursor}::timestamptz)
     ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit + 1})
    ORDER BY created_at DESC, kind, id DESC
    LIMIT ${limit + 1}`;
  const items: ManualItem[] = rows.slice(0, limit).map((r) => ({
    kind: r.kind, id: Number(r.id), date: r.date, line: r.line, title: r.title, amount: r.amount, cogs: r.cogs,
    client: r.client, source: r.source, accountName: r.account_name, createdAt: r.created_at.toISOString(),
  }));
  return c.json({ items, nextCursor: rows.length > limit ? rows[limit - 1].cur : null });
});

/* ---------------------------------------------------------------- bot & aksi */

api.get("/bot", async (c) => {
  const q = rq(c), cfg = await loadConfig();
  const scope = resolveScope(q.acc, cfg), r = resolveRange(q.from, q.to, q.preset);
  return c.json(await listActions(scope.accountIds, r.from, r.to, c.req.query("cursor") || undefined));
});

api.post("/actions", owner, async (c) => {
  const b = z.object({ campaignId: z.string().min(1), action: z.enum(["pause", "activate", "scale"]), pct: z.number().optional() }).parse(await c.req.json());
  return c.json(await createCampaignAction({ ...b, source: "table", userId: c.get("user").id }), 201);
});
api.get("/actions/:id{[0-9]+}", async (c) => c.json(await getAction(Number(c.req.param("id")))));
api.post("/actions/:id{[0-9]+}/confirm", owner, async (c) => c.json(await confirmAction(Number(c.req.param("id")))));
api.post("/actions/:id{[0-9]+}/cancel", owner, async (c) => c.json(await cancelAction(Number(c.req.param("id")))));
api.post("/actions/:id{[0-9]+}/revert", owner, async (c) => c.json(await revertAction(Number(c.req.param("id")))));

const chatLimiter = rateLimit(env.CHAT_RATE_PER_HOUR, 3600_000, (c) => "chat:" + (c as Context<AppEnv>).get("user").id);
api.post("/chat", chatLimiter, async (c) => {
  const b = z.object({
    message: z.string().trim().min(1).max(2000),
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) })).max(30).default([]),
    context: z.object({ acc: z.string(), from: z.string().refine(isDateKey), to: z.string().refine(isDateKey) }),
    conversationId: z.string().uuid().optional(),
    attachments: z.array(z.string().max(40)).max(4).default([]),
  }).parse(await c.req.json());
  const user = c.get("user");
  // Lampiran dikenalkan ke bot sebagai baris teks berisi media_id (bot memakainya di upload_media_to_meta).
  const files = b.attachments.map((id) => getMedia(id, user.id));
  if (files.some((f) => !f)) throw new HTTPException(400, { message: "Lampiran sudah kedaluwarsa atau dihapus. Upload ulang file-nya." });
  const message = files.length ? `${b.message}\n\n${files.map((f) => attachmentLine(attachmentOf(f!))).join("\n")}` : b.message;
  return streamSSE(c, async (stream) => {
    // Tulis berurutan dan tunggu semuanya terkirim sebelum stream ditutup.
    let chain = Promise.resolve();
    const send = (e: ChatEvent) => { chain = chain.then(() => stream.writeSSE({ data: JSON.stringify(e) })).catch(() => {}); };
    await handleChat({ ...b, message, conversationId: b.conversationId ?? randomUUID() }, user, send);
    await chain;
  });
});

// Lampiran foto/video untuk iklan. Body = isi file mentah (dialirkan ke disk, tidak ditampung di RAM).
const mediaLimiter = rateLimit(30, 3600_000, (c) => "media:" + (c as Context<AppEnv>).get("user").id);
api.put("/chat/media", owner, mediaLimiter, async (c) => {
  if (Number(c.req.header("content-length") ?? 0) > MEDIA_LIMITS.video) throw new MediaError(`File terlalu besar. Maksimal video ${MEDIA_LIMITS.video / 1048576} MB.`, 413);
  let name = "lampiran";
  try { name = decodeURIComponent(c.req.header("x-file-name") ?? name); } catch { /* nama default */ }
  const coverFor = c.req.header("x-cover-for") || undefined; // frame cover yang diambil browser dari video
  return c.json(await saveMedia(c.req.raw.body, { name, userId: c.get("user").id, coverFor }), 201);
});
api.delete("/chat/media/:id", owner, async (c) => {
  await removeMedia(c.req.param("id"), c.get("user").id);
  return c.json({ ok: true });
});

/* ---------------------------------------------------------------- pengaturan */

const settingsSchema = z.object({
  targetRoas: z.number().min(0).max(100), maxCpa: z.number().int().min(0).nullable(), maxCpl: z.number().int().min(0).nullable(),
  killAfterSpend: z.number().int().min(0), scaleStepPct: z.number().int().min(1).max(50), adTaxPct: z.number().min(0).max(50),
  maxDailyBudget: z.number().int().min(0).nullable(),
}).partial();

api.patch("/accounts/:id/settings", owner, async (c) => {
  const id = c.req.param("id");
  const b = settingsSchema.parse(await c.req.json());
  const cfg = await loadConfig();
  if (!cfg.accounts.some((a) => a.id === id)) throw new HTTPException(404, { message: "Akun tidak ditemukan" });
  const rule = ["targetRoas", "maxCpa", "maxCpl", "killAfterSpend", "scaleStepPct"] as const;
  for (const f of rule) if (b[f] !== undefined && b[f] !== null) await updateRule([id], f, b[f] as number, c.get("user"), "table");
  if (b.adTaxPct !== undefined || b.maxDailyBudget !== undefined || b.maxCpa === null || b.maxCpl === null) {
    await sql`
      UPDATE account_settings SET
        ad_tax_pct = COALESCE(${b.adTaxPct ?? null}, ad_tax_pct),
        max_daily_budget = ${b.maxDailyBudget === undefined ? sql`max_daily_budget` : b.maxDailyBudget},
        max_cpa = ${b.maxCpa === null ? null : sql`max_cpa`}, max_cpl = ${b.maxCpl === null ? null : sql`max_cpl`},
        updated_at = now(), updated_by = ${c.get("user").id}
      WHERE account_id = ${id}`;
    await bumpDataVersion();
  }
  return c.json({ ok: true });
});

const accountSchema = z.object({
  name: z.string().trim().min(1).max(100), line: z.enum(["digital", "jasa"]), resultActionType: z.string().min(1).max(120),
  botMode: z.enum(["off", "suggest", "auto"]), active: z.boolean(), timezone: z.string().max(60),
});
api.post("/accounts", owner, async (c) => {
  const b = accountSchema.partial({ botMode: true, active: true, timezone: true, resultActionType: true })
    .extend({ id: z.string().regex(/^\d{5,25}$/, "ID akun berupa angka (tanpa act_)") }).parse(await c.req.json());
  let tz = b.timezone ?? "Asia/Jakarta";
  if (metaConfigured()) {
    try { tz = (await fetchAccountInfo(b.id)).timezone_name || tz; } catch (e) { throw new HTTPException(400, { message: "Token tidak bisa membaca akun ini: " + errMsg(e) }); }
  }
  const d = DEFAULT_SETTINGS[b.line];
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO ad_accounts (id, display_name, line, result_action_type, bot_mode, active, timezone)
      VALUES (${b.id}, ${b.name}, ${b.line}, ${b.resultActionType ?? (b.line === "jasa" ? "onsite_conversion.messaging_conversation_started_7d" : "omni_purchase")},
              ${b.botMode ?? "suggest"}, ${b.active ?? true}, ${tz})`;
    await tx`
      INSERT INTO account_settings (account_id, target_roas, max_cpa, max_cpl, ad_tax_pct, scale_step_pct, kill_after_spend)
      VALUES (${b.id}, ${d.targetRoas}, ${d.maxCpa}, ${d.maxCpl}, ${d.adTaxPct}, ${d.scaleStepPct}, ${d.killAfterSpend})`;
  });
  await bumpDataVersion();
  if (metaConfigured()) void runSync("backfill", b.id).catch(() => {});
  return c.json({ ok: true }, 201);
});
api.patch("/accounts/:id", owner, async (c) => {
  const b = accountSchema.partial().parse(await c.req.json());
  const res = await sql`
    UPDATE ad_accounts SET
      display_name = COALESCE(${b.name ?? null}, display_name), line = COALESCE(${b.line ?? null}::business_line, line),
      result_action_type = COALESCE(${b.resultActionType ?? null}, result_action_type), bot_mode = COALESCE(${b.botMode ?? null}::bot_mode, bot_mode),
      active = COALESCE(${b.active ?? null}, active), timezone = COALESCE(${b.timezone ?? null}, timezone)
    WHERE id = ${c.req.param("id")} RETURNING id`;
  if (!res.length) throw new HTTPException(404, { message: "Akun tidak ditemukan" });
  await bumpDataVersion();
  return c.json({ ok: true });
});

const productSchema = z.object({
  line: z.enum(["digital", "jasa"]), name: z.string().trim().min(1).max(200), price: money.nullable(), cogs: money, url: z.string().url().max(500).nullable(), active: z.boolean(),
});
api.post("/products", owner, async (c) => {
  const b = productSchema.partial({ price: true, url: true, active: true, cogs: true }).parse(await c.req.json());
  const [r] = await sql`
    INSERT INTO products (line, name, price, cogs, url) VALUES (${b.line}, ${b.name}, ${b.price ?? null}, ${b.cogs ?? 0}, ${b.url ?? null})
    ON CONFLICT (line, name) DO UPDATE SET price = EXCLUDED.price, cogs = EXCLUDED.cogs, url = EXCLUDED.url, active = true
    RETURNING id`;
  await bumpDataVersion();
  return c.json({ id: Number(r.id) }, 201);
});
api.patch("/products/:id{[0-9]+}", owner, async (c) => {
  const b = productSchema.partial().parse(await c.req.json());
  await sql`
    UPDATE products SET name = COALESCE(${b.name ?? null}, name),
      price = ${b.price === undefined ? sql`price` : b.price}, cogs = COALESCE(${b.cogs ?? null}, cogs),
      url = ${b.url === undefined ? sql`url` : b.url}, active = COALESCE(${b.active ?? null}, active)
    WHERE id = ${Number(c.req.param("id"))}`;
  await bumpDataVersion();
  return c.json({ ok: true });
});

api.post("/fixed-costs", owner, async (c) => {
  const b = z.object({ line: z.enum(["digital", "jasa"]), name: z.string().trim().min(1).max(200), monthly: money.refine((v) => v > 0) }).parse(await c.req.json());
  const [r] = await sql`INSERT INTO fixed_costs (line, name, monthly) VALUES (${b.line}, ${b.name}, ${b.monthly}) RETURNING id`;
  await bumpDataVersion();
  return c.json({ id: Number(r.id) }, 201);
});
api.delete("/fixed-costs/:id{[0-9]+}", owner, async (c) => {
  await sql`UPDATE fixed_costs SET active_to = CURRENT_DATE - 1 WHERE id = ${Number(c.req.param("id"))}`;
  await bumpDataVersion();
  return c.json({ ok: true });
});
api.patch("/line-settings/:line", owner, async (c) => {
  const line = z.enum(["digital", "jasa"]).parse(c.req.param("line"));
  const b = z.object({ feePct: z.number().min(0).max(50) }).parse(await c.req.json());
  await sql`UPDATE line_settings SET fee_pct = ${b.feePct} WHERE line = ${line}`;
  await bumpDataVersion();
  return c.json({ ok: true });
});

api.get("/users", owner, async (c) => c.json(await sql`SELECT id::int, email, name, role FROM users ORDER BY id`));
api.post("/users", owner, async (c) => {
  const b = z.object({ email: z.string().email(), name: z.string().trim().min(1).max(100), role: z.enum(["owner", "admin"]), password: z.string().min(10).max(200) }).parse(await c.req.json());
  const [r] = await sql`
    INSERT INTO users (email, name, role, password_hash) VALUES (${b.email.toLowerCase()}, ${b.name}, ${b.role}, ${await hashPassword(b.password)})
    ON CONFLICT (email) DO NOTHING RETURNING id`;
  if (!r) throw new HTTPException(409, { message: "Email sudah terdaftar" });
  return c.json({ id: Number(r.id) }, 201);
});

let lastManualSync = 0;
api.post("/sync", owner, async (c) => {
  if (!metaConfigured()) throw new HTTPException(400, { message: "Token Meta belum diisi di server" });
  if (Date.now() - lastManualSync < 5 * 60_000) throw new HTTPException(429, { message: "Sinkron manual maksimal 1x per 5 menit" });
  lastManualSync = Date.now();
  void runSync("manual").catch((e) => log.error("sync manual", { error: errMsg(e) }));
  return c.json({ ok: true, started: true }, 202);
});

/* ---------------------------------------------------------------- SSE */

api.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    const send = (e: ServerEvent) => { void stream.writeSSE({ data: JSON.stringify(e) }); };
    const unsub = subscribe(send);
    send({ type: "version", v: dataVersion() });
    const ping = setInterval(() => { void stream.writeSSE({ event: "ping", data: "" }); }, 25_000);
    await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
    clearInterval(ping);
    unsub();
  }));

app.route("/api", api);

// Tool dashboard untuk Claude Code di host (lihat mcp-server.ts). Tidak lewat /api: tanpa cookie, pakai token sesi chat.
app.post("/internal/mcp", mcpHandler);
app.on(["GET", "DELETE"], "/internal/mcp", (c) => c.body(null, 405));
app.all("/api/*", (c) => c.json({ error: "Endpoint tidak ada" }, 404));

/* ---------------------------------------------------------------- web statis */

const staticRoot = path.resolve(env.STATIC_DIR);
if (existsSync(staticRoot)) {
  const indexHtml = readFileSync(path.join(staticRoot, "index.html"), "utf8");
  app.use("/assets/*", async (c, next) => { await next(); c.header("Cache-Control", "public, max-age=31536000, immutable"); });
  app.use("*", serveStatic({ root: path.relative(process.cwd(), staticRoot) || "." }));
  app.get("*", (c) => {
    c.header("Cache-Control", "no-cache");
    return c.html(indexHtml);
  });
}
