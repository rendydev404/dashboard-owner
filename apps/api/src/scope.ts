// Konfigurasi akun (di-cache per versi data) dan resolusi filter akun/periode dari query string.
import { HTTPException } from "hono/http-exception";
import {
  type Account, type Line, type Product, type FixedCost, type LineSetting,
  clampRange, compareRange, isDateKey, lenDays, presetRange, todayKey, PRESETS, type Preset,
} from "@iklan/shared";
import { sql } from "./db";
import { cached } from "./cache";

export interface Config {
  accounts: Account[];
  products: Product[];
  fixedCosts: FixedCost[];
  lineSettings: LineSetting[];
}

export function loadConfig(): Promise<Config> {
  return cached("config", async () => {
    const [accounts, products, fixedCosts, lineSettings] = await Promise.all([
      sql`
        SELECT a.id, a.display_name, a.line, a.result_action_type, a.bot_mode, a.active, a.timezone, a.last_synced_at,
               s.target_roas, s.max_cpa, s.max_cpl, s.ad_tax_pct, s.scale_step_pct, s.kill_after_spend, s.max_daily_budget
        FROM ad_accounts a JOIN account_settings s ON s.account_id = a.id
        ORDER BY a.sort_order, a.display_name`,
      sql`SELECT id, line, name, price, cogs, url, active FROM products ORDER BY line, name`,
      sql`SELECT id, line, name, monthly FROM fixed_costs WHERE active_to IS NULL OR active_to >= CURRENT_DATE ORDER BY line, id`,
      sql`SELECT line, fee_pct FROM line_settings ORDER BY line`,
    ]);
    return {
      accounts: accounts.map((r) => ({
        id: r.id, name: r.display_name, line: r.line, resultActionType: r.result_action_type, botMode: r.bot_mode,
        active: r.active, timezone: r.timezone, lastSyncedAt: r.last_synced_at?.toISOString?.() ?? null,
        settings: {
          targetRoas: r.target_roas, maxCpa: r.max_cpa, maxCpl: r.max_cpl, adTaxPct: r.ad_tax_pct,
          scaleStepPct: r.scale_step_pct, killAfterSpend: r.kill_after_spend, maxDailyBudget: r.max_daily_budget,
        },
      })),
      products: products.map((r) => ({ id: Number(r.id), line: r.line, name: r.name, price: r.price, cogs: r.cogs, url: r.url, active: r.active })),
      fixedCosts: fixedCosts.map((r) => ({ id: Number(r.id), line: r.line, name: r.name, monthly: r.monthly })),
      lineSettings: lineSettings.map((r) => ({ line: r.line, feePct: r.fee_pct })),
    };
  });
}

export interface Scope {
  acc: string;
  accounts: Account[];
  accountIds: string[];
  lines: Line[];
  /** Filter penjualan jasa ke akun tertentu (kalau satu akun jasa dipilih). */
  salesAccountId: string | null;
}

export function resolveScope(acc: string | undefined, cfg: Config): Scope {
  const active = cfg.accounts.filter((a) => a.active);
  const a = acc || "all";
  if (a === "all") return { acc: a, accounts: active, accountIds: active.map((x) => x.id), lines: ["digital", "jasa"], salesAccountId: null };
  if (a === "digital" || a === "jasa") {
    const accs = active.filter((x) => x.line === a);
    return { acc: a, accounts: accs, accountIds: accs.map((x) => x.id), lines: [a], salesAccountId: null };
  }
  const one = cfg.accounts.find((x) => x.id === a);
  if (!one) throw new HTTPException(400, { message: "Akun tidak dikenal" });
  return { acc: a, accounts: [one], accountIds: [one.id], lines: [one.line], salesAccountId: one.line === "jasa" ? one.id : null };
}

export interface Range { from: string; to: string; prevFrom: string; prevTo: string; days: number; today: string }

export function resolveRange(from?: string, to?: string, preset?: string): Range {
  const today = todayKey();
  let s: string, e: string;
  if (preset && (PRESETS as readonly string[]).includes(preset)) [s, e] = presetRange(preset as Preset, today);
  else if (isDateKey(from) && isDateKey(to)) [s, e] = clampRange(from, to, today);
  else [s, e] = presetRange("7d", today);
  if (lenDays(s, e) > 400) throw new HTTPException(400, { message: "Periode maksimal 400 hari" });
  const [ps, pe] = compareRange(s, e);
  return { from: s, to: e, prevFrom: ps, prevTo: pe, days: lenDays(s, e), today };
}
