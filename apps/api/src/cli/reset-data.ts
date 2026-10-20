// Hapus SEMUA data bisnis (akun iklan, kampanye, penjualan, biaya, log). Akun user tetap ada.
// Pemakaian: tsx src/cli/reset-data.ts --yes
import { sql } from "../db";
if (!process.argv.includes("--yes")) { console.error("Tambahkan --yes untuk menghapus semua data bisnis."); process.exit(1); }
await sql.unsafe("TRUNCATE sales, manual_costs, fixed_costs, products, bot_actions, chat_messages, lynk_events, sync_runs, account_hourly, campaign_daily, campaigns, account_settings, ad_accounts RESTART IDENTITY CASCADE");
await sql`UPDATE line_settings SET fee_pct = 0`;
await sql`UPDATE app_state SET value = to_jsonb((value::text)::bigint + 1) WHERE key = 'data_version'`;
console.log("Semua data bisnis dihapus.");
await sql.end();
