// Impor insights Meta harian per kampanye dari file JSON hasil ekspor Meta Ads MCP (ads_get_ad_entities,
// level campaign, time_increment=1). Dipakai sebagai jalan pintas sebelum token System User dipasang di server.
// Pemakaian: tsx src/cli/import-meta-export.ts <file.json> <accountId> "<nama akun>" <digital|jasa>
//            tsx src/cli/import-meta-export.ts --hourly <file.json> <accountId>
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS, type Line } from "@iklan/shared";
import { sql } from "../db";
import { migrate } from "../migrate";

const args = process.argv.slice(2);
const hourly = args[0] === "--hourly";
const [file, accountId, name, line] = hourly ? args.slice(1) : args;
if (!file || !accountId) { console.error("Pemakaian: lihat komentar di atas file"); process.exit(1); }

const raw = JSON.parse(readFileSync(file, "utf8"));
const rows: any[] = typeof raw.ad_entities === "string" ? JSON.parse(raw.ad_entities) : raw.ad_entities;
const val = (x: any) => Math.round(Number(x?.value ?? x ?? 0) || 0);
await migrate();

if (hourly) {
  const data = rows.map((r) => ({
    account_id: accountId, date: r.date_start,
    hour: Number(String(r.hourly_stats_aggregated_by_advertiser_time_zone ?? r.hourly_stats_aggregated_by_audience_time_zone ?? "0").slice(0, 2)),
    spend: val(r.amount_spent), impressions: val(r.impressions), clicks: val(r.link_click), leads: 0, purchases: val(r.omni_purchase),
  })).filter((r) => r.spend || r.impressions);
  await sql`DELETE FROM account_hourly WHERE account_id = ${accountId}`;
  for (let i = 0; i < data.length; i += 1000) await sql`INSERT INTO account_hourly ${sql(data.slice(i, i + 1000))}`;
  console.log(`Per jam: ${data.length} baris`);
} else {
  const L = (line as Line) || "digital";
  const st = DEFAULT_SETTINGS[L];
  await sql`INSERT INTO ad_accounts (id, display_name, line, result_action_type, bot_mode) VALUES (${accountId}, ${name}, ${L}, ${L === "jasa" ? "onsite_conversion.messaging_conversation_started_7d" : "omni_purchase"}, 'suggest')
            ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`;
  await sql`INSERT INTO account_settings (account_id, target_roas, max_cpa, max_cpl, ad_tax_pct, scale_step_pct, kill_after_spend)
            VALUES (${accountId}, ${st.targetRoas}, ${st.maxCpa}, ${st.maxCpl}, ${st.adTaxPct}, ${st.scaleStepPct}, ${st.killAfterSpend}) ON CONFLICT DO NOTHING`;
  // Status & budget kampanye = baris terbaru tiap kampanye.
  const latest = new Map<string, any>();
  for (const r of rows) if (!latest.has(r.id) || r.date_start > latest.get(r.id).date_start) latest.set(r.id, r);
  for (const c of latest.values()) {
    const budget = c.daily_budget ? val(c.daily_budget) : null;
    await sql`INSERT INTO campaigns (id, account_id, name, status, effective_status, daily_budget, is_cbo)
              VALUES (${c.id}, ${accountId}, ${c.name}, ${c.status ?? "PAUSED"}, ${c.effective_status ?? c.status ?? "PAUSED"}, ${budget}, ${budget != null})
              ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, effective_status = EXCLUDED.effective_status, daily_budget = EXCLUDED.daily_budget, updated_at = now()`;
  }
  const data = rows.map((r) => ({
    campaign_id: r.id, date: r.date_start, account_id: accountId, spend: val(r.amount_spent), impressions: val(r.impressions),
    clicks: val(r.link_click), leads: 0, purchases: val(r.omni_purchase), purchase_value: val(r.omni_purchase_values),
  })).filter((r) => r.spend || r.impressions || r.clicks || r.purchases);
  await sql`DELETE FROM campaign_daily WHERE account_id = ${accountId}`;
  for (let i = 0; i < data.length; i += 1000) await sql`INSERT INTO campaign_daily ${sql(data.slice(i, i + 1000))}`;
  await sql`UPDATE ad_accounts SET last_synced_at = now() WHERE id = ${accountId}`;
  console.log(`Kampanye: ${latest.size}, harian: ${data.length} baris, total spend Rp${data.reduce((t, r) => t + r.spend, 0).toLocaleString("id-ID")}`);
}
await sql`UPDATE app_state SET value = to_jsonb((value::text)::bigint + 1) WHERE key = 'data_version'`;
await sql.end();
