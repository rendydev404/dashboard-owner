// Uji integrasi jalur MCP terhadap DB dev memakai server MCP tiruan yang memutar ulang respons ASLI Meta
// (file hasil ads_get_ad_entities). Tidak ada panggilan ke Meta sungguhan.
// Pemakaian: tsx src/cli/verify-mcp-bridge.ts <daily.json> <hourly.json>
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const [dailyFile, hourlyFile] = process.argv.slice(2);
const load = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const daily = JSON.parse(load(dailyFile).ad_entities) as any[];
const hourly = JSON.parse(load(hourlyFile).ad_entities) as any[];
const latest = new Map<string, any>();
for (const e of daily) if (!latest.has(e.id) || e.date_start > latest.get(e.id).date_start) latest.set(e.id, e);

const log: { tool: string; args: any }[] = [];
let activeId = "";
const server = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    const m = JSON.parse(b);
    if (m.method === "notifications/initialized") return void res.writeHead(202).end();
    if (m.method === "initialize") return void res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }));
    const { name, arguments: a } = m.params;
    log.push({ tool: name, args: a });
    let body: any = {};
    if (name === "ads_get_ad_entities") {
      let rows: any[];
      if (a.level === "adset") rows = [{ id: "AS1", name: "Ad set 1", campaign_id: activeId, daily_budget: { value: "100000", unit: "IDR" } }, { id: "AS2", name: "Ad set lain", campaign_id: "lain", daily_budget: { value: "50000", unit: "IDR" } }];
      else if (a.breakdowns) rows = hourly;
      else if (a.time_increment) rows = daily;
      else if (a.object_ids) rows = a.object_ids.map((id: string) => latest.get(id)).filter(Boolean);
      else if (a.level === "campaign") rows = [...latest.values()].map(({ date_start, date_stop, amount_spent, impressions, link_click, omni_purchase, omni_purchase_values, ...c }) => c);
      else rows = [];
      body = { ad_entities: JSON.stringify(rows) };
    } else body = { ok: true, id: a.entity_id }; // ads_update_entity / ads_activate_entity
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(body) }] } }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const cred = path.join(mkdtempSync(path.join(tmpdir(), "vmcp-")), "cred.json");
writeFileSync(cred, JSON.stringify({ mcpOAuth: { k: { serverName: "meta_ads", accessToken: "fake-token", expiresAt: Date.now() + 40 * 864e5 } } }));
process.env.META_MCP_CRED = cred;
process.env.META_MCP_URL = `http://127.0.0.1:${(server.address() as any).port}`;
delete process.env.META_SYSTEM_USER_TOKEN;

const { sql } = await import("../db");
const { runSync } = await import("../meta/sync");
const { metaMode } = await import("../env");
const { createCampaignAction, confirmAction, revertAction } = await import("../actions");
const ok = (m: string) => console.log("  ✓", m);

assert.equal(metaMode(), "mcp"); ok("mode jalur = mcp (kredensial terbaca)");

const before = await sql`SELECT (SELECT count(*) FROM campaign_daily)::int d, (SELECT count(*) FROM account_hourly)::int h, (SELECT count(*) FROM campaigns)::int c, (SELECT coalesce(sum(spend),0) FROM campaign_daily) s`;
const r = await runSync("nightly");
const after = await sql`SELECT (SELECT count(*) FROM campaign_daily)::int d, (SELECT count(*) FROM account_hourly)::int h, (SELECT count(*) FROM campaigns)::int c, (SELECT coalesce(sum(spend),0) FROM campaign_daily) s`;
assert.equal(r.ok, true);
assert.deepEqual(after[0], before[0]); ok(`sync nightly lewat MCP sukses, data identik (${after[0].d} harian, ${after[0].h} per jam, ${after[0].c} kampanye, spend Rp${Number(after[0].s).toLocaleString("id-ID")})`);
assert.equal(r.rows, 0); ok("upsert idempoten: 0 baris diubah");
const tools = new Set(log.map((l) => l.tool));
assert.deepEqual([...tools], ["ads_get_ad_entities"]); ok("sync hanya memanggil ads_get_ad_entities (baca saja)");
const hourlyCall = log.find((l) => l.args.breakdowns);
assert.deepEqual(hourlyCall!.args.breakdowns, ["hourly_stats_aggregated_by_advertiser_time_zone"]); ok("per jam memakai breakdown jam zona waktu pengiklan");

// Aksi: pause → batalkan; scale CBO → batalkan; scale ABO (ad set) → batalkan. Hanya ke server tiruan.
const [u] = await sql`SELECT id FROM users ORDER BY id LIMIT 1`;
const [camp] = await sql`SELECT id, account_id FROM campaigns WHERE status = 'ACTIVE' LIMIT 1`;
const [cbo] = await sql`SELECT id, daily_budget FROM campaigns WHERE daily_budget IS NOT NULL LIMIT 1`;
assert.ok(camp && cbo, "perlu satu kampanye ACTIVE dan satu kampanye dengan budget harian");
activeId = camp.id;
log.length = 0;
let a = await createCampaignAction({ campaignId: camp.id, action: "pause", source: "table", userId: Number(u.id) });
assert.equal(a.status, "pending"); assert.equal(log.filter((l) => l.tool !== "ads_get_ad_entities").length, 0); ok("membuat aksi pause = pending, belum ada tulisan ke Meta");
a = await confirmAction(a.id);
assert.equal(a.status, "executed");
const upd = log.find((l) => l.tool === "ads_update_entity")!;
assert.deepEqual(JSON.parse(upd.args.fields), { status: "PAUSED" });
assert.equal(upd.args.entity_type, "campaign"); assert.equal(upd.args.entity_id, camp.id); assert.equal(upd.args.advertiser_job, "update_existing_campaigns");
ok("konfirmasi pause → ads_update_entity {status: PAUSED}");
log.length = 0;
a = await revertAction(a.id);
assert.equal(log.at(-1)!.tool, "ads_activate_entity"); assert.equal(log.at(-1)!.args.entity_id, camp.id);
ok("batalkan aksi → ads_activate_entity (nyalakan lagi)");
assert.equal((await sql`SELECT status FROM campaigns WHERE id = ${camp.id}`)[0].status, "ACTIVE"); ok("status kampanye di DB kembali ACTIVE");

// Scale kampanye CBO (budget di kampanye)
log.length = 0;
const s1 = await createCampaignAction({ campaignId: cbo.id, action: "scale", pct: 20, source: "table", userId: Number(u.id) });
a = await confirmAction(s1.id);
assert.equal(a.status, "executed");
const want = Math.round(cbo.daily_budget * 1.2);
const su = log.find((l) => l.tool === "ads_update_entity")!;
assert.deepEqual(JSON.parse(su.args.fields), { daily_budget: want }); assert.equal(su.args.entity_type, "campaign");
ok(`scale CBO +20% → ads_update_entity {daily_budget: ${want}} (dari ${cbo.daily_budget})`);
await revertAction(a.id);
assert.equal(Number((await sql`SELECT daily_budget FROM campaigns WHERE id = ${cbo.id}`)[0].daily_budget), Number(cbo.daily_budget)); ok("budget CBO kembali ke nilai semula");

// Scale kampanye ABO (budget di ad set aktif milik kampanye itu saja)
log.length = 0;
const s2 = await createCampaignAction({ campaignId: camp.id, action: "scale", pct: 20, source: "table", userId: Number(u.id) });
assert.deepEqual((s2.params as any).adsets, [{ id: "AS1", name: "Ad set 1", before: 100000, after: 120000 }]); ok("scale ABO hanya menyentuh ad set milik kampanye (AS1), AS2 milik kampanye lain diabaikan");
a = await confirmAction(s2.id);
const au = log.find((l) => l.tool === "ads_update_entity")!;
assert.equal(a.status, "executed"); assert.equal(au.args.entity_type, "ad_set"); assert.equal(au.args.entity_id, "AS1"); assert.deepEqual(JSON.parse(au.args.fields), { daily_budget: 120000 });
ok("konfirmasi → ads_update_entity entity_type=ad_set {daily_budget: 120000}");
log.length = 0;
await revertAction(a.id);
const back = log.find((l) => l.tool === "ads_update_entity")!;
assert.deepEqual(JSON.parse(back.args.fields), { daily_budget: 100000 }); ok("batalkan → ad set kembali Rp100.000");

// Konfirmasi dobel tidak boleh mengeksekusi dua kali.
log.length = 0;
const d = await createCampaignAction({ campaignId: camp.id, action: "pause", source: "table", userId: Number(u.id) });
const [x, y] = await Promise.allSettled([confirmAction(d.id), confirmAction(d.id)]);
assert.equal([x, y].filter((q) => q.status === "fulfilled").length, 1);
assert.equal(log.filter((l) => l.tool === "ads_update_entity").length, 1); ok("klik konfirmasi dobel → hanya dieksekusi sekali");
await revertAction(d.id);

// Token kedaluwarsa → sync gagal dengan pesan jelas, tanpa panggilan ke Meta.
writeFileSync(cred, JSON.stringify({ mcpOAuth: { k: { serverName: "meta_ads", accessToken: "fake-token", expiresAt: Date.now() - 1000 } } }));
log.length = 0;
const bad = await runSync("manual");
const { lastMetaError } = await import("../meta/sync");
assert.equal(bad.ok, false); assert.match(String(lastMetaError), /login ulang Claude Code/); assert.equal(log.length, 0);
ok(`token kedaluwarsa → pesan: "${lastMetaError}"`);

// Bersihkan jejak uji.
await sql`DELETE FROM bot_actions WHERE campaign_id = ANY(${[camp.id, cbo.id]})`;
await sql`DELETE FROM sync_runs WHERE kind IN ('nightly','manual')`;
await sql`UPDATE app_state SET value = to_jsonb((value::text)::bigint + 1) WHERE key = 'data_version'`;
server.close();
await sql.end();
console.log("\nJalur MCP terverifikasi.");
