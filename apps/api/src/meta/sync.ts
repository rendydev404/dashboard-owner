// Sinkronisasi Meta → Postgres (PLANNING §5). Sumber data bisa lewat MCP Meta Ads (token login Claude Code di VPS)
// atau Graph API (System User token). Keduanya dinormalisasi lalu ditulis lewat upsert batch yang sama,
// dan hanya baris yang benar-benar berubah yang ditulis.
import { addDays, todayKey, type Account } from "@iklan/shared";
import { sql, bumpDataVersion } from "../db";
import { log, errMsg } from "../log";
import { metaGet, metaGetAll, actionValue, PURCHASE_TYPES, MetaError } from "./client";
import { McpError, getEntities, num, rupiah } from "./mcp";
import { emit } from "../events";
import { loadConfig } from "../scope";
import { metaMode, metaConfigured } from "../env";

export type SyncKind = "recent" | "nightly" | "backfill" | "manual";
const RANGE_DAYS: Record<SyncKind, number> = { recent: 2, manual: 2, nightly: 28, backfill: 180 };

export let lastMetaError: string | null = null;

export interface CampaignMeta { id: string; name: string; status: string; effective_status: string; objective: string | null; daily_budget: number | null; lifetime_budget: number | null; created_time: string | null }
export interface DailyRow { campaign_id: string; date: string; spend: number; impressions: number; clicks: number; leads: number; purchases: number; purchase_value: number }
export interface HourRow { date: string; hour: number; spend: number; impressions: number; clicks: number; leads: number; purchases: number }

/* ------------------------------------------------------------------ penulisan ke DB (sumber-agnostik) */

async function upsertCampaigns(accId: string, list: CampaignMeta[]) {
  if (!list.length) return;
  const col = <K extends keyof CampaignMeta>(k: K) => list.map((c) => c[k] ?? null);
  await sql`
    INSERT INTO campaigns (id, account_id, name, status, effective_status, objective, daily_budget, lifetime_budget, is_cbo, created_time, updated_at)
    SELECT id, ${accId}, name, status, effective_status, objective, daily_budget, lifetime_budget,
           (daily_budget IS NOT NULL OR lifetime_budget IS NOT NULL), created_time, now()
    FROM unnest(${col("id")}::text[], ${col("name")}::text[], ${col("status")}::text[], ${col("effective_status")}::text[],
                ${col("objective")}::text[], ${col("daily_budget")}::bigint[], ${col("lifetime_budget")}::bigint[], ${col("created_time")}::timestamptz[])
      AS t(id, name, status, effective_status, objective, daily_budget, lifetime_budget, created_time)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, status = EXCLUDED.status, effective_status = EXCLUDED.effective_status, objective = COALESCE(EXCLUDED.objective, campaigns.objective),
      daily_budget = EXCLUDED.daily_budget, lifetime_budget = EXCLUDED.lifetime_budget, is_cbo = EXCLUDED.is_cbo, updated_at = now()`;
}

async function upsertDaily(accId: string, data: DailyRow[]) {
  if (!data.length) return 0;
  const col = <K extends keyof DailyRow>(k: K) => data.map((d) => d[k]);
  const res = await sql`
    INSERT INTO campaign_daily (campaign_id, date, account_id, spend, impressions, clicks, leads, purchases, purchase_value)
    SELECT c, d, ${accId}, s, i, k, l, p, v
    FROM unnest(${col("campaign_id")}::text[], ${col("date")}::date[], ${col("spend")}::bigint[], ${col("impressions")}::bigint[],
                ${col("clicks")}::bigint[], ${col("leads")}::int[], ${col("purchases")}::int[], ${col("purchase_value")}::bigint[])
      AS t(c, d, s, i, k, l, p, v)
    WHERE EXISTS (SELECT 1 FROM campaigns WHERE id = t.c)
    ON CONFLICT (campaign_id, date) DO UPDATE SET
      spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
      leads = EXCLUDED.leads, purchases = EXCLUDED.purchases, purchase_value = EXCLUDED.purchase_value, synced_at = now()
    WHERE (campaign_daily.spend, campaign_daily.impressions, campaign_daily.clicks, campaign_daily.leads, campaign_daily.purchases, campaign_daily.purchase_value)
      IS DISTINCT FROM (EXCLUDED.spend, EXCLUDED.impressions, EXCLUDED.clicks, EXCLUDED.leads, EXCLUDED.purchases, EXCLUDED.purchase_value)`;
  return res.count;
}

async function upsertHourly(accId: string, data: HourRow[]) {
  if (!data.length) return 0;
  const col = <K extends keyof HourRow>(k: K) => data.map((d) => d[k]);
  const res = await sql`
    INSERT INTO account_hourly (account_id, date, hour, spend, impressions, clicks, leads, purchases)
    SELECT ${accId}, d, h, s, i, k, l, p
    FROM unnest(${col("date")}::date[], ${col("hour")}::smallint[], ${col("spend")}::bigint[], ${col("impressions")}::bigint[],
                ${col("clicks")}::bigint[], ${col("leads")}::int[], ${col("purchases")}::int[]) AS t(d, h, s, i, k, l, p)
    ON CONFLICT (account_id, date, hour) DO UPDATE SET
      spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, leads = EXCLUDED.leads, purchases = EXCLUDED.purchases
    WHERE (account_hourly.spend, account_hourly.clicks, account_hourly.leads, account_hourly.purchases)
      IS DISTINCT FROM (EXCLUDED.spend, EXCLUDED.clicks, EXCLUDED.leads, EXCLUDED.purchases)`;
  return res.count;
}

/* ------------------------------------------------------------------ sumber 1: MCP Meta Ads */

const MCP_CAMPAIGN_FIELDS = ["id", "name", "status", "effective_status", "daily_budget", "amount_spent", "impressions", "link_click", "omni_purchase", "omni_purchase_values", "lead", "results"];
const MCP_HOURLY_FIELDS = ["amount_spent", "impressions", "link_click", "omni_purchase", "lead", "results"];
const HOURLY_BREAKDOWN = "hourly_stats_aggregated_by_advertiser_time_zone";

/** Hasil kampanye jasa = lead; kalau field `lead` kosong, pakai `results` selama indikatornya pesan/lead. */
export function leadsOf(e: any, line: "digital" | "jasa"): number {
  if (line !== "jasa") return 0;
  const l = Math.round(num(e.lead));
  if (l) return l;
  const ind = String(e.results?.indicator ?? "");
  return /messag|lead|conversation/i.test(ind) ? Math.round(num(e.results)) : 0;
}

export function parseDailyRows(rows: any[], line: "digital" | "jasa"): { campaigns: CampaignMeta[]; daily: DailyRow[] } {
  const latest = new Map<string, any>();
  const daily: DailyRow[] = [];
  for (const e of rows) {
    if (!e?.id || !e.date_start) continue;
    const prev = latest.get(e.id);
    if (!prev || e.date_start > prev.date_start) latest.set(e.id, e);
    const r: DailyRow = {
      campaign_id: String(e.id), date: e.date_start, spend: rupiah(e.amount_spent), impressions: Math.round(num(e.impressions)),
      clicks: Math.round(num(e.link_click)), leads: leadsOf(e, line), purchases: Math.round(num(e.omni_purchase)), purchase_value: rupiah(e.omni_purchase_values),
    };
    if (r.spend || r.impressions || r.clicks || r.purchases || r.leads) daily.push(r);
  }
  const campaigns = [...latest.values()].map((c): CampaignMeta => ({
    id: String(c.id), name: c.name ?? String(c.id), status: c.status ?? "PAUSED", effective_status: c.effective_status ?? c.status ?? "PAUSED", objective: null,
    daily_budget: c.daily_budget != null ? rupiah(c.daily_budget) || null : null, lifetime_budget: null, created_time: null,
  }));
  return { campaigns, daily };
}

export function parseHourlyRows(rows: any[], line: "digital" | "jasa"): HourRow[] {
  const out: HourRow[] = [];
  for (const e of rows) {
    const h = String(e[HOURLY_BREAKDOWN] ?? "").slice(0, 2);
    if (!/^\d{2}$/.test(h) || !e.date_start) continue; // baris "null" dilewati
    const r: HourRow = { date: e.date_start, hour: Number(h), spend: rupiah(e.amount_spent), impressions: Math.round(num(e.impressions)), clicks: Math.round(num(e.link_click)), leads: leadsOf(e, line), purchases: Math.round(num(e.omni_purchase)) };
    if (r.spend || r.impressions) out.push(r);
  }
  return out;
}

async function mcpSyncAccount(acc: Account, since: string, until: string): Promise<number> {
  const base = { ad_account_id: acc.id };
  const ctx = { request: "laporan performa iklan" };
  const range = JSON.stringify({ since, until });
  const [meta, daily, hourly] = await Promise.all([
    // Status & budget terkini semua kampanye (termasuk yang tidak berjalan di rentang ini).
    getEntities({ ...base, level: "campaign", date_preset: "last_7d", fields: ["id", "name", "status", "effective_status", "daily_budget", "lifetime_budget", "objective", "created_time"], limit: 200 }, ctx),
    getEntities({ ...base, level: "campaign", time_range: range, time_increment: "1", fields: MCP_CAMPAIGN_FIELDS, limit: 1000 }, ctx),
    getEntities({ ...base, level: "ad_account", time_range: range, time_increment: "1", breakdowns: [HOURLY_BREAKDOWN], fields: MCP_HOURLY_FIELDS, limit: 1000 }, ctx),
  ]);
  const d = parseDailyRows(daily, acc.line);
  const byId = new Map<string, CampaignMeta>();
  for (const c of d.campaigns) byId.set(c.id, c);
  for (const e of meta) { // metadata terkini menimpa turunan dari baris harian
    if (!e?.id) continue;
    byId.set(String(e.id), {
      id: String(e.id), name: e.name ?? String(e.id), status: e.status ?? "PAUSED", effective_status: e.effective_status ?? e.status ?? "PAUSED",
      objective: e.objective ?? null, daily_budget: e.daily_budget != null ? rupiah(e.daily_budget) || null : null,
      lifetime_budget: e.lifetime_budget != null ? rupiah(e.lifetime_budget) || null : null, created_time: e.created_time ?? null,
    });
  }
  await upsertCampaigns(acc.id, [...byId.values()]);
  return (await upsertDaily(acc.id, d.daily)) + (await upsertHourly(acc.id, parseHourlyRows(hourly, acc.line)));
}

/* ------------------------------------------------------------------ sumber 2: Graph API */

async function graphSyncAccount(acc: Account, since: string, until: string): Promise<number> {
  const camps = await metaGetAll(`act_${acc.id}/campaigns`, { fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time" });
  await upsertCampaigns(acc.id, camps.map((c: any): CampaignMeta => ({
    id: c.id, name: c.name, status: c.status, effective_status: c.effective_status, objective: c.objective ?? null,
    daily_budget: c.daily_budget != null ? Number(c.daily_budget) : null, lifetime_budget: c.lifetime_budget != null ? Number(c.lifetime_budget) : null, created_time: c.created_time ?? null,
  })));
  const rows = await metaGetAll(`act_${acc.id}/insights`, {
    level: "campaign", time_increment: 1, time_range: JSON.stringify({ since, until }),
    fields: "campaign_id,spend,impressions,inline_link_clicks,actions,action_values,date_start",
  });
  const daily = rows.map((r: any): DailyRow => ({
    campaign_id: r.campaign_id, date: r.date_start, spend: Math.round(Number(r.spend) || 0), impressions: Number(r.impressions) || 0, clicks: Number(r.inline_link_clicks) || 0,
    leads: acc.line === "jasa" ? actionValue(r.actions, [acc.resultActionType]) : 0, purchases: actionValue(r.actions, PURCHASE_TYPES), purchase_value: actionValue(r.action_values, PURCHASE_TYPES),
  }));
  const hrows = await metaGetAll(`act_${acc.id}/insights`, {
    level: "account", time_increment: 1, time_range: JSON.stringify({ since, until }), breakdowns: HOURLY_BREAKDOWN,
    fields: "spend,impressions,inline_link_clicks,actions,date_start",
  });
  const hourly = hrows.map((r: any): HourRow => ({
    date: r.date_start, hour: Number(String(r[HOURLY_BREAKDOWN]).slice(0, 2)), spend: Math.round(Number(r.spend) || 0), impressions: Number(r.impressions) || 0,
    clicks: Number(r.inline_link_clicks) || 0, leads: acc.line === "jasa" ? actionValue(r.actions, [acc.resultActionType]) : 0, purchases: actionValue(r.actions, PURCHASE_TYPES),
  }));
  return (await upsertDaily(acc.id, daily)) + (await upsertHourly(acc.id, hourly));
}

/* ------------------------------------------------------------------ orkestrasi */

const authFailure = (e: unknown) => (e instanceof MetaError && e.isAuth) || (e instanceof McpError && (e.code === "auth" || e.code === "expired"));

/** Jalankan sinkronisasi untuk semua akun aktif. Dikunci advisory lock supaya tidak dobel. */
export async function runSync(kind: SyncKind, onlyAccount?: string): Promise<{ ok: boolean; rows: number; skipped?: string }> {
  if (!metaConfigured()) return { ok: false, rows: 0, skipped: "Meta belum terhubung (login Claude Code di VPS atau token System User)" };
  const mode = metaMode();
  // Advisory lock level sesi harus dipegang di satu koneksi yang sama sampai dilepas.
  const conn = await sql.reserve();
  const [{ locked }] = await conn`SELECT pg_try_advisory_lock(724002) AS locked`;
  if (!locked) { conn.release(); return { ok: false, rows: 0, skipped: "Sinkronisasi lain sedang berjalan" }; }
  let total = 0, failed = false;
  try {
    const cfg = await loadConfig();
    const accs = cfg.accounts.filter((a) => a.active && (!onlyAccount || a.id === onlyAccount));
    const until = todayKey();
    for (const acc of accs) {
      const [run] = await sql`INSERT INTO sync_runs (kind, account_id) VALUES (${kind}, ${acc.id}) RETURNING id`;
      try {
        let rows = 0;
        // Rentang panjang dipecah per 30 hari supaya respons Meta tetap kecil.
        const days = RANGE_DAYS[kind];
        const floor = addDays(until, -(days - 1));
        for (let end = until; ; ) {
          const start = addDays(end, -29) < floor ? floor : addDays(end, -29);
          rows += mode === "mcp" ? await mcpSyncAccount(acc, start, end) : await graphSyncAccount(acc, start, end);
          if (start <= floor) break;
          end = addDays(start, -1);
        }
        await sql`UPDATE sync_runs SET finished_at = now(), rows = ${rows}, status = 'ok', since = ${floor}, until = ${until} WHERE id = ${run.id}`;
        await sql`UPDATE ad_accounts SET last_synced_at = now() WHERE id = ${acc.id}`;
        total += rows;
      } catch (e) {
        failed = true;
        lastMetaError = authFailure(e) ? (mode === "mcp" ? "Token Meta Ads kedaluwarsa / belum login: login ulang Claude Code di VPS (user claude-ads)" : "Token Meta tidak valid / kedaluwarsa") : errMsg(e);
        await sql`UPDATE sync_runs SET finished_at = now(), status = 'error', error = ${errMsg(e)} WHERE id = ${run.id}`;
        log.error("sync gagal", { account: acc.id, kind, mode, error: errMsg(e) });
        if (authFailure(e)) break; // percuma lanjut ke akun lain dengan token yang sama
      }
    }
    if (!failed) lastMetaError = null;
    // Selalu naikkan versi: last_synced_at berubah (banner "terakhir sinkron") walau metrik sama.
    await bumpDataVersion();
    emit({ type: "sync", status: failed ? "error" : "ok" });
    return { ok: !failed, rows: total };
  } finally {
    await conn`SELECT pg_advisory_unlock(724002)`.catch(() => {});
    conn.release();
  }
}

/** Info akun dari Meta (validasi akses & zona waktu saat akun ditambahkan). */
export async function fetchAccountInfo(id: string): Promise<{ name?: string; timezone_name?: string }> {
  if (metaMode() === "mcp") {
    const [e] = await getEntities({ ad_account_id: id, level: "ad_account", date_preset: "today", fields: ["name", "timezone_name"] }, { request: "cek akun iklan" });
    if (!e) throw new McpError("Akun tidak bisa dibaca oleh login Meta ini", "tool");
    return { name: e.name, timezone_name: e.timezone_name };
  }
  return metaGet(`act_${id}`, { fields: "name,currency,timezone_name,account_status" });
}
