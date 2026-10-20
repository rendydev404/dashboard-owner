// Aksi kampanye (pause / aktifkan / scale) dengan alur wajib konfirmasi.
// Bot & tombol tabel hanya bisa MEMBUAT aksi berstatus pending. Eksekusi hanya lewat confirmAction(),
// yang dipanggil endpoint konfirmasi dari tombol/kata "ya" user — tidak pernah oleh model AI.
import { HTTPException } from "hono/http-exception";
import { rp, type BotAction } from "@iklan/shared";
import { sql, bumpDataVersion } from "./db";
import { metaConfigured } from "./env";
import { fetchActiveAdsets, fetchCampaignState, setDailyBudget, setStatus } from "./meta/ops";
import { emit } from "./events";
import { errMsg, log } from "./log";
import { loadConfig } from "./scope";

export type CampaignAction = "pause" | "activate" | "scale";
const MAX_SCALE_PCT = 50;
const EXPIRE_MIN = 10;

interface AdsetBudget { id: string; name: string; before: number; after: number }
interface Params {
  before: { status: string; dailyBudget: number | null };
  after: { status: string; dailyBudget: number | null };
  pct?: number;
  adsets?: AdsetBudget[];
  demo?: boolean;
  field?: string; value?: number; previous?: number | null;
}

const actionSelect = () => sql`
  SELECT b.id, b.account_id, a.display_name AS account_name, b.campaign_id, c.name AS campaign_name, b.action, b.params,
         b.source, b.status, b.reason, b.error, b.created_at, b.expires_at, b.executed_at
  FROM bot_actions b
  LEFT JOIN ad_accounts a ON a.id = b.account_id
  LEFT JOIN campaigns c ON c.id = b.campaign_id`;

export function toAction(r: any): BotAction {
  return {
    id: Number(r.id), accountId: r.account_id, accountName: r.account_name, campaignId: r.campaign_id, campaignName: r.campaign_name,
    action: r.action, params: r.params, source: r.source,
    status: r.status === "pending" && r.expires_at && new Date(r.expires_at) < new Date() ? "expired" : r.status,
    reason: r.reason, error: r.error, createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at?.toISOString() ?? null, executedAt: r.executed_at?.toISOString() ?? null,
  };
}

export async function getAction(id: number): Promise<BotAction> {
  const [r] = await sql`${actionSelect()} WHERE b.id = ${id}`;
  if (!r) throw new HTTPException(404, { message: "Aksi tidak ditemukan" });
  return toAction(r);
}

/** Cari kampanye dari potongan nama (skor = jumlah kata yang cocok), seperti findCampaign() di prototipe. */
const STOP = new Set(["pause", "matikan", "stop", "jeda", "aktifkan", "nyalakan", "hidupkan", "jalankan", "scale", "naikkan", "naikin",
  "budget", "kampanye", "campaign", "iklan", "yang", "itu", "dong", "tolong", "please", "akun", "the", "dan"]);
export async function findCampaigns(query: string, accountIds: string[]) {
  const toks = query.toLowerCase().split(/[^a-z0-9%+.]+/).filter((w) => w.length > 1 && !STOP.has(w));
  if (!toks.length || !accountIds.length) return [];
  const rows = await sql`
    SELECT c.id, c.name, c.status, c.account_id, c.daily_budget, a.display_name AS account_name
    FROM campaigns c JOIN ad_accounts a ON a.id = c.account_id
    WHERE c.account_id = ANY(${accountIds}) AND c.status <> 'ARCHIVED' AND c.status <> 'DELETED'`;
  return rows
    .map((r) => {
      const n = (r.name as string).toLowerCase();
      return {
        id: r.id as string, name: r.name as string, status: r.status as string, account_id: r.account_id as string,
        account_name: r.account_name as string, score: toks.filter((w) => n.includes(w)).length + (r.status === "ACTIVE" ? 0.1 : 0),
      };
    })
    .filter((r) => r.score >= 1)
    .sort((a, b) => b.score - a.score);
}

export async function createCampaignAction(opts: {
  campaignId: string; action: CampaignAction; pct?: number; source: "chat" | "table"; userId: number; reason?: string;
}): Promise<BotAction> {
  const [c] = await sql`SELECT id, account_id, name, status, daily_budget, is_cbo FROM campaigns WHERE id = ${opts.campaignId}`;
  if (!c) throw new HTTPException(404, { message: "Kampanye tidak ditemukan" });
  const cfg = await loadConfig();
  const acc = cfg.accounts.find((a) => a.id === c.account_id)!;
  const live = metaConfigured();

  let status = c.status as string, daily: number | null = c.daily_budget;
  if (live) {
    const fresh = await fetchCampaignState(c.account_id, c.id);
    status = fresh.status; daily = fresh.dailyBudget;
  }
  const params: Params = { before: { status, dailyBudget: daily }, after: { status, dailyBudget: daily }, demo: !live };

  if (opts.action === "pause") {
    if (status === "PAUSED") throw new HTTPException(409, { message: `${c.name} sudah dalam status jeda` });
    params.after.status = "PAUSED";
  } else if (opts.action === "activate") {
    if (status === "ACTIVE") throw new HTTPException(409, { message: `${c.name} sudah aktif` });
    params.after.status = "ACTIVE";
  } else {
    const pct = Math.min(Math.max(opts.pct ?? acc.settings.scaleStepPct, 1), MAX_SCALE_PCT);
    params.pct = pct;
    const cap = acc.settings.maxDailyBudget;
    const up = (v: number) => {
      const next = Math.round(v * (1 + pct / 100));
      return cap ? Math.min(next, cap) : next;
    };
    if (daily) params.after.dailyBudget = up(daily);
    else if (live) {
      // ABO: budget ada di level ad set.
      const adsets = await fetchActiveAdsets(c.account_id, c.id);
      params.adsets = adsets.map((a) => ({ id: a.id, name: a.name, before: a.budget, after: up(a.budget) }));
      if (!params.adsets.length) throw new HTTPException(409, { message: "Kampanye ini tidak punya budget harian yang bisa dinaikkan" });
    } else throw new HTTPException(409, { message: "Budget harian kampanye ini belum diketahui" });
  }

  const [row] = await sql`
    INSERT INTO bot_actions (account_id, campaign_id, action, params, source, status, reason, requested_by, expires_at)
    VALUES (${c.account_id}, ${c.id}, ${opts.action}, ${sql.json(params as any)}, ${opts.source}, 'pending', ${opts.reason ?? null},
            ${opts.userId}, now() + make_interval(mins => ${EXPIRE_MIN}))
    RETURNING id`;
  return getAction(Number(row.id));
}

/** Kalimat ringkas untuk kartu konfirmasi & log. */
export function describeAction(a: BotAction): string {
  const p = a.params as unknown as Params;
  if (a.action === "pause") return `Pause ${a.campaignName}`;
  if (a.action === "activate") return `Aktifkan ${a.campaignName}`;
  if (a.action === "scale") {
    if (p.adsets?.length) return `Naikkan budget ${p.pct}% untuk ${p.adsets.length} ad set di ${a.campaignName}`;
    return `Naikkan budget ${a.campaignName} dari ${rp(p.before.dailyBudget ?? 0)} ke ${rp(p.after.dailyBudget ?? 0)}/hari`;
  }
  if (a.action === "update_rule") return `Ubah aturan ${p.field} jadi ${p.value}`;
  return a.action;
}

async function apply(campaignId: string, p: Params, target: "after" | "before") {
  const want = p[target];
  const other = p[target === "after" ? "before" : "after"];
  const live = metaConfigured() && !p.demo;
  const responses: unknown[] = [];
  if (live) {
    const [{ account_id: accountId }] = await sql`SELECT account_id FROM campaigns WHERE id = ${campaignId}`;
    if (want.status !== other.status) responses.push(await setStatus(accountId, campaignId, want.status as "ACTIVE" | "PAUSED"));
    const wasActive = want.status === "ACTIVE";
    if (p.adsets?.length) {
      for (const s of p.adsets) responses.push(await setDailyBudget(accountId, s.id, "ad_set", target === "after" ? s.after : s.before, wasActive));
    } else if (want.dailyBudget != null && want.dailyBudget !== other.dailyBudget) {
      responses.push(await setDailyBudget(accountId, campaignId, "campaign", want.dailyBudget, wasActive));
    }
  }
  await sql`
    UPDATE campaigns SET status = ${want.status}, effective_status = ${want.status},
      daily_budget = COALESCE(${p.adsets?.length ? null : want.dailyBudget}::bigint, daily_budget), updated_at = now()
    WHERE id = ${campaignId}`;
  return live ? responses : [{ demo: true }];
}

export async function confirmAction(id: number): Promise<BotAction> {
  // Klaim atomik: expires_at dikosongkan, jadi konfirmasi kedua (klik dobel) tidak lolos lagi.
  const [claimed] = await sql`
    UPDATE bot_actions SET expires_at = NULL
    WHERE id = ${id} AND status = 'pending' AND expires_at > now()
    RETURNING id, campaign_id, action, params`;
  if (!claimed) {
    const cur = await getAction(id);
    throw new HTTPException(409, { message: cur.status === "expired" ? "Konfirmasi sudah kedaluwarsa, minta ulang ke bot" : "Aksi ini sudah diproses" });
  }
  try {
    const resp = await apply(claimed.campaign_id, claimed.params, "after");
    await sql`UPDATE bot_actions SET status = 'executed', executed_at = now(), meta_response = ${sql.json(resp as any)} WHERE id = ${id}`;
    log.info("aksi dieksekusi", { id, action: claimed.action, campaign: claimed.campaign_id });
  } catch (e) {
    await sql`UPDATE bot_actions SET status = 'failed', error = ${errMsg(e)} WHERE id = ${id}`;
    log.error("aksi gagal", { id, error: errMsg(e) });
  }
  await bumpDataVersion();
  const a = await getAction(id);
  emit({ type: "action", id, status: a.status });
  return a;
}

export async function cancelAction(id: number): Promise<BotAction> {
  await sql`UPDATE bot_actions SET status = 'cancelled', expires_at = NULL WHERE id = ${id} AND status = 'pending'`;
  return getAction(id);
}

export async function revertAction(id: number): Promise<BotAction> {
  const [r] = await sql`
    UPDATE bot_actions SET status = 'reverted' WHERE id = ${id} AND status = 'executed' AND action IN ('pause','activate','scale')
    RETURNING campaign_id, params`;
  if (!r) throw new HTTPException(409, { message: "Hanya aksi yang sudah dieksekusi yang bisa dibatalkan" });
  try {
    await apply(r.campaign_id, r.params, "before");
  } catch (e) {
    await sql`UPDATE bot_actions SET status = 'executed', error = ${"Gagal membatalkan: " + errMsg(e)} WHERE id = ${id}`;
    throw new HTTPException(502, { message: "Gagal membatalkan di Meta: " + errMsg(e) });
  }
  await bumpDataVersion();
  return getAction(id);
}

/** Catat perubahan aturan sebagai aksi yang langsung berstatus executed (tidak mengeluarkan uang). */
export async function logRuleChange(accountId: string, field: string, value: number, previous: number | null, userId: number, source: "chat" | "table") {
  await sql`
    INSERT INTO bot_actions (account_id, action, params, source, status, reason, requested_by, executed_at)
    VALUES (${accountId}, 'update_rule', ${sql.json({ field, value, previous })}, ${source}, 'executed', 'Diubah owner', ${userId}, now())`;
}

export async function listActions(accountIds: string[], from: string, to: string, cursor?: string, limit = 30) {
  let cAt: string | null = null, cId = 0;
  if (cursor) [cAt, cId] = [cursor.split("_")[0], Number(cursor.split("_")[1])];
  const rows = await sql`
    ${actionSelect()}
    WHERE (b.account_id = ANY(${accountIds}) OR b.account_id IS NULL)
      AND b.created_at >= (${from}::date AT TIME ZONE 'Asia/Jakarta')
      AND b.created_at < ((${to}::date + 1) AT TIME ZONE 'Asia/Jakarta')
      AND (${cAt}::timestamptz IS NULL OR (b.created_at, b.id) < (${cAt}::timestamptz, ${cId}))
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit).map(toAction);
  const last = rows[limit - 1];
  return { actions: items, nextCursor: rows.length > limit ? `${last.created_at.toISOString()}_${last.id}` : null };
}
