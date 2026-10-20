// Operasi baca/tulis kampanye ke Meta, lewat MCP (ads_update_entity / ads_activate_entity) atau Graph API.
// Semua dipanggil HANYA dari alur konfirmasi di actions.ts.
import { metaMode } from "../env";
import { metaGet, metaGetAll, metaPost } from "./client";
import { callTool, getEntities, conversationId, unwrap, rupiah } from "./mcp";

export interface CampaignState { status: string; dailyBudget: number | null }
export interface AdsetState { id: string; name: string; budget: number }

const job = (request: string) => ({ job: "update_existing_campaigns", request });

export async function fetchCampaignState(accountId: string, campaignId: string): Promise<CampaignState> {
  if (metaMode() === "mcp") {
    const [e] = await getEntities({ ad_account_id: accountId, level: "campaign", object_ids: [campaignId], date_preset: "today", fields: ["id", "status", "effective_status", "daily_budget"] }, job("cek status kampanye"));
    if (!e) throw new Error("Kampanye tidak ditemukan di Meta");
    return { status: e.status, dailyBudget: e.daily_budget != null ? rupiah(e.daily_budget) || null : null };
  }
  const f = await metaGet(campaignId, { fields: "status,daily_budget" });
  return { status: f.status, dailyBudget: f.daily_budget != null ? Number(f.daily_budget) : null };
}

/** Ad set aktif milik kampanye (untuk kampanye ABO yang budget-nya ada di level ad set). */
export async function fetchActiveAdsets(accountId: string, campaignId: string): Promise<AdsetState[]> {
  if (metaMode() === "mcp") {
    const rows = await getEntities({
      ad_account_id: accountId, level: "adset", date_preset: "today", limit: 200,
      filtering: [{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }],
      fields: ["id", "name", "campaign_id", "daily_budget"],
    }, job("cek ad set kampanye"));
    return rows.filter((a) => String(a.campaign_id) === campaignId && a.daily_budget != null).map((a) => ({ id: String(a.id), name: a.name, budget: rupiah(a.daily_budget) }));
  }
  const list = await metaGetAll(`${campaignId}/adsets`, { fields: "id,name,status,daily_budget" });
  return list.filter((a: any) => a.status === "ACTIVE" && a.daily_budget).map((a: any) => ({ id: a.id, name: a.name, budget: Number(a.daily_budget) }));
}

export async function setStatus(accountId: string, campaignId: string, status: "ACTIVE" | "PAUSED"): Promise<unknown> {
  if (metaMode() === "mcp") {
    const base = { ad_account_id: accountId, entity_id: campaignId, entity_type: "campaign" };
    const ctx = { conv: conversationId(), ...job(status === "PAUSED" ? "pause kampanye" : "aktifkan kampanye") };
    if (status === "ACTIVE") return callTool("ads_activate_entity", base, ctx);
    const r = await callTool("ads_update_entity", { ...base, fields: JSON.stringify({ status: "PAUSED" }) }, ctx);
    return publishIfDraft(r, accountId, campaignId, "campaign", ctx);
  }
  return metaPost(campaignId, { status });
}

/** Ubah budget harian satu entity (kampanye CBO atau ad set). `wasActive`: nyalakan lagi kalau Meta mem-pause paksa saat edit. */
export async function setDailyBudget(accountId: string, entityId: string, type: "campaign" | "ad_set", budget: number, wasActive: boolean): Promise<unknown> {
  if (metaMode() === "mcp") {
    const ctx = { conv: conversationId(), ...job("ubah budget harian") };
    const r = await callTool("ads_update_entity", { ad_account_id: accountId, entity_id: entityId, entity_type: type, fields: JSON.stringify({ daily_budget: budget }) }, ctx);
    const out = await publishIfDraft(r, accountId, entityId, type, ctx);
    if (wasActive && (r as any)?.status_forced_to_paused) {
      return { update: out, aktif_lagi: await callTool("ads_activate_entity", { ad_account_id: accountId, entity_id: entityId, entity_type: type }, ctx) };
    }
    return out;
  }
  return metaPost(entityId, { daily_budget: budget });
}

/** Akun mode draft: perubahan perlu dipublikasikan (tanpa mengaktifkan objek yang sedang jeda). */
async function publishIfDraft(r: any, accountId: string, entityId: string, type: string, ctx: Parameters<typeof callTool>[2]) {
  if (r?.is_draft || unwrap(r?.active_errors) != null) {
    const publish = await callTool("ads_activate_entity", { ad_account_id: accountId, entity_id: entityId, entity_type: type, object_ids: [entityId], publish_as_active: false }, ctx);
    return { update: r, publish };
  }
  return r;
}
