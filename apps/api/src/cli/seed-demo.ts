// Data contoh untuk development/staging (porting sampleDB() prototipe). Jangan dipakai di produksi.
// Pemakaian: pnpm seed:demo [--days=180] [--force]
import { addDays, todayKey, hourNow, DEFAULT_SETTINGS } from "@iklan/shared";
import { sql } from "../db";
import { migrate } from "../migrate";
import { isProd } from "../env";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "1"]));
if (isProd && !args.force) {
  console.error("Menolak seed demo di produksi (pakai --force kalau memang staging).");
  process.exit(1);
}
const DAYS = Number(args.days || 180);

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(42);
const HW = [0.2, 0.12, 0.08, 0.06, 0.06, 0.1, 0.3, 0.55, 0.75, 0.85, 0.9, 1, 1.1, 1, 0.9, 0.85, 0.9, 1, 1.15, 1.35, 1.5, 1.45, 1.1, 0.6];
function pick<T extends { w: number }>(arr: T[]): T {
  let r = R() * arr.reduce((s, x) => s + x.w, 0);
  for (const x of arr) { r -= x.w; if (r <= 0) return x; }
  return arr[arr.length - 1];
}
const CLIENTS = ["PT Maju Digital", "CV Sinar Abadi", "Klinik Sehat Utama", "Toko Berkah Online", "PT Nusantara Retail", "Kopi Kenangan Lokal", "Agensi Kreatif ID", "Rumah Belajar Pintar"];

type Camp = { id: string; name: string; status: string; w: number; ctr: number; cpa?: number; cpl?: number; close?: number; budget: number; startDaysAgo?: number; stopDaysAgo?: number };
const DEFS = [
  {
    id: "900000000008768", name: "DEMO · Adv Habib Akbar-02", line: "digital" as const, base: 420_000, result: "omni_purchase",
    campaigns: [
      { id: "d1", name: "BUNDLE | Broad | Purchase", status: "ACTIVE", w: 0.35, ctr: 0.015, cpa: 31000, budget: 150_000 },
      { id: "d2", name: "Ecourse AI Agent | LAL 1%", status: "ACTIVE", w: 0.22, ctr: 0.014, cpa: 50000, budget: 100_000 },
      { id: "d3", name: "Prompt Pack | Interest AI", status: "ACTIVE", w: 0.17, ctr: 0.013, cpa: 29000, budget: 75_000 },
      { id: "d4", name: "Retarget | Visitor 14d", status: "ACTIVE", w: 0.1, ctr: 0.019, cpa: 24000, budget: 50_000 },
      { id: "d5", name: "Template Konten | Test Kreatif", status: "ACTIVE", w: 0.1, ctr: 0.011, cpa: 95000, budget: 50_000 },
      { id: "d6", name: "Ebook AI | Advantage+", status: "ACTIVE", w: 0.06, ctr: 0.012, cpa: 46000, budget: 30_000, startDaysAgo: 40 },
    ] as Camp[],
    products: [
      { name: "Bundle AI Creator (All in One)", url: "https://lynk.id/spbaicreator", price: 149000, cogs: 0, w: 0.4 },
      { name: "Ecourse AI Agent", url: "https://lynk.id/spbaicreator", price: 199000, cogs: 0, w: 0.17 },
      { name: "Prompt Pack Konten Viral", url: "https://lynk.id/spbaicreator", price: 49000, cogs: 0, w: 0.24 },
      { name: "Template Konten 30 Hari", url: "https://lynk.id/spbaicreator", price: 79000, cogs: 0, w: 0.09 },
      { name: "Ebook Cuan dari AI", url: "https://lynk.id/spbaicreator", price: 59000, cogs: 0, w: 0.1 },
    ],
    fixed: [["Langganan AI & API", 450_000], ["Server / hosting bot", 150_000], ["Tools desain & editing", 120_000]] as [string, number][],
  },
  {
    id: "900000000005521", name: "DEMO · Adv Jasa AI Agent", line: "jasa" as const, base: 300_000, result: "onsite_conversion.messaging_conversation_started_7d",
    campaigns: [
      { id: "j1", name: "Leads WA | Jasa AI Agent | Broad", status: "ACTIVE", w: 0.5, ctr: 0.012, cpl: 38000, close: 0.035, budget: 150_000 },
      { id: "j2", name: "Leads WA | Corporate | LAL 2%", status: "ACTIVE", w: 0.35, ctr: 0.009, cpl: 66000, close: 0.05, budget: 100_000 },
      { id: "j3", name: "Retarget | Engager IG 30d", status: "ACTIVE", w: 0.15, ctr: 0.016, cpl: 27000, close: 0.03, budget: 50_000 },
    ] as Camp[],
    products: [
      { name: "Jasa Bikin AI Agent (Basic)", url: null, price: 7_500_000, cogs: 2_500_000, w: 0.55 },
      { name: "Paket AI Agent Corporate", url: null, price: 25_000_000, cogs: 9_000_000, w: 0.15 },
      { name: "Konsultasi AI 1 Jam", url: null, price: 750_000, cogs: 0, w: 0.3 },
    ],
    fixed: [["Gaji admin CS", 2_500_000], ["Tools CRM & WA API", 400_000]] as [string, number][],
  },
];

async function chunked<T extends Record<string, unknown>>(table: string, rows: T[], size = 1000) {
  for (let i = 0; i < rows.length; i += size) {
    const part = rows.slice(i, i + size);
    await sql`INSERT INTO ${sql(table)} ${sql(part as any, Object.keys(part[0]) as any)}`;
  }
}

await migrate();
const ids = DEFS.map((d) => d.id);
console.log("Menghapus data demo lama…");
await sql`DELETE FROM sales WHERE account_id = ANY(${ids}) OR (channel = 'lynk' AND lynk_ref_id LIKE 'demo-%')`;
await sql`DELETE FROM account_hourly WHERE account_id = ANY(${ids})`;
await sql`DELETE FROM bot_actions WHERE account_id = ANY(${ids})`;
await sql`DELETE FROM ad_accounts WHERE id = ANY(${ids})`; // cascade: settings, campaigns, campaign_daily
await sql`DELETE FROM manual_costs WHERE name LIKE '[demo]%'`;
await sql`DELETE FROM fixed_costs WHERE name LIKE '[demo]%'`;

const today = todayKey(), nowH = hourNow();
for (const [i, a] of DEFS.entries()) {
  const st = DEFAULT_SETTINGS[a.line];
  await sql`INSERT INTO ad_accounts (id, display_name, line, result_action_type, bot_mode, sort_order) VALUES (${a.id}, ${a.name}, ${a.line}, ${a.result}, 'suggest', ${i})`;
  await sql`INSERT INTO account_settings (account_id, target_roas, max_cpa, max_cpl, ad_tax_pct, scale_step_pct, kill_after_spend)
            VALUES (${a.id}, ${st.targetRoas}, ${st.maxCpa}, ${st.maxCpl}, ${st.adTaxPct}, ${st.scaleStepPct}, ${st.killAfterSpend})`;
  for (const c of a.campaigns) {
    await sql`INSERT INTO campaigns (id, account_id, name, status, effective_status, daily_budget, is_cbo)
              VALUES (${a.id + c.id}, ${a.id}, ${c.name}, ${c.status}, ${c.status}, ${c.budget}, true)`;
  }
  const prodIds: Record<string, number> = {};
  for (const p of a.products) {
    const [r] = await sql`INSERT INTO products (line, name, price, cogs, url) VALUES (${a.line}, ${p.name}, ${p.price}, ${p.cogs}, ${p.url})
                          ON CONFLICT (line, name) DO UPDATE SET price = EXCLUDED.price, cogs = EXCLUDED.cogs RETURNING id`;
    prodIds[p.name] = Number(r.id);
  }
  for (const [name, monthly] of a.fixed) await sql`INSERT INTO fixed_costs (line, name, monthly, active_from) VALUES (${a.line}, ${"[demo] " + name}, ${monthly}, ${addDays(today, -DAYS)})`;

  const daily: Record<string, unknown>[] = [], hourly: Record<string, unknown>[] = [], sales: Record<string, unknown>[] = [];
  let ref = 0;
  for (let ago = DAYS - 1; ago >= 0; ago--) {
    const date = addDays(today, -ago);
    const hrs = ago === 0 ? nowH + 1 : 24;
    const frac = ago === 0 ? HW.slice(0, hrs).reduce((s, x) => s + x, 0) / HW.reduce((s, x) => s + x, 0) : 1;
    const trend = 0.75 + ((DAYS - ago) / DAYS) * 0.5;
    const wk = [1.1, 0.95, 0.95, 1, 1, 1.05, 1.15][new Date(date + "T00:00:00Z").getUTCDay()];
    const T = { spend: 0, clicks: 0, leads: 0, purchases: 0, impr: 0 };
    const saleHours: number[] = [];
    for (const c of a.campaigns) {
      if (c.startDaysAgo != null && ago > c.startDaysAgo) continue;
      if (c.stopDaysAgo != null && ago < c.stopDaysAgo) continue;
      const spend = Math.round(a.base * c.w * trend * wk * (0.75 + R() * 0.5) * frac);
      const impressions = Math.round(spend * (0.35 + R() * 0.15));
      const clicks = Math.round(impressions * c.ctr * (0.8 + R() * 0.4));
      let leads = 0, purchases = 0, value = 0;
      if (a.line === "jasa") {
        leads = Math.round((spend / c.cpl!) * (0.7 + R() * 0.6));
        for (let l = 0; l < leads; l++) if (R() < c.close!) {
          const p = pick(a.products);
          sales.push({ line: "jasa", account_id: a.id, product_id: prodIds[p.name], product_name: p.name, date, occurred_at: `${date}T05:00:00Z`, qty: 1,
            revenue: p.price, cogs: p.cogs, client: CLIENTS[Math.floor(R() * CLIENTS.length)], source: "iklan", channel: "manual" });
        }
      } else {
        purchases = Math.max(0, Math.round((spend / c.cpa!) * (0.7 + R() * 0.6)));
        for (let k = 0; k < purchases; k++) {
          const p = pick(a.products);
          value += p.price;
          if (R() < 0.9) {
            const h = Math.min(hrs - 1, Math.floor(R() * hrs));
            saleHours.push(h);
            sales.push({ line: "digital", account_id: null, product_id: prodIds[p.name], product_name: p.name, date,
              occurred_at: new Date(Date.parse(`${date}T${String(h).padStart(2, "0")}:${String(Math.floor(R() * 60)).padStart(2, "0")}:00+07:00`)).toISOString(),
              qty: 1, revenue: p.price, cogs: null, client: null, source: "lynk", channel: "lynk", lynk_ref_id: `demo-${a.id}-${ref++}`, lynk_item_ix: 0 });
          }
        }
      }
      daily.push({ campaign_id: a.id + c.id, date, account_id: a.id, spend, impressions, clicks, leads, purchases, purchase_value: value });
      T.spend += spend; T.clicks += clicks; T.leads += leads; T.purchases += purchases; T.impr += impressions;
    }
    const ws = HW.slice(0, hrs), wsum = ws.reduce((s, x) => s + x, 0);
    const conv = ws.map((w) => ({ w: Math.pow(w, 1.6) }));
    const H = ws.map((w, h) => ({ account_id: a.id, date, hour: h, spend: Math.round((T.spend * w) / wsum), impressions: Math.round((T.impr * w) / wsum), clicks: Math.round((T.clicks * w) / wsum), leads: 0, purchases: 0 }));
    for (let k = 0; k < T.purchases; k++) H[conv.indexOf(pick(conv))].purchases++;
    for (let k = 0; k < T.leads; k++) H[conv.indexOf(pick(conv))].leads++;
    hourly.push(...H);
  }
  // Kampanye test kreatif dimatikan 5 hari lalu.
  if (a.line === "digital") await sql`UPDATE campaigns SET status = 'PAUSED', effective_status = 'PAUSED' WHERE id = ${a.id + "d5"}`;
  if (a.line === "digital") for (const d of daily) if (d.campaign_id === a.id + "d5" && (d.date as string) > addDays(today, -5)) { d.spend = 0; d.impressions = 0; d.clicks = 0; d.purchases = 0; d.purchase_value = 0; }

  await chunked("campaign_daily", daily);
  await chunked("account_hourly", hourly);
  // Kolom harus seragam per batch.
  const norm = sales.map((s) => ({ lynk_ref_id: null, lynk_item_ix: null, ...s }));
  await chunked("sales", norm);
  console.log(`${a.name}: ${daily.length} baris harian, ${hourly.length} per jam, ${sales.length} penjualan`);

  const ACTIONS: [string, string][] = [["scale", "ROAS di atas target 3 hari berturut-turut"], ["pause", "Biaya per hasil lewat batas"], ["activate", "Dinyalakan lagi setelah ganti kreatif"]];
  const logs = Array.from({ length: 25 }, () => {
    const [action, reason] = ACTIONS[Math.floor(R() * ACTIONS.length)];
    const c = a.campaigns[Math.floor(R() * a.campaigns.length)];
    const ago = Math.floor(R() * 75);
    return { account_id: a.id, campaign_id: a.id + c.id, action, params: sql.json({ demo: true, pct: 20, before: { status: "ACTIVE", dailyBudget: c.budget }, after: { status: action === "pause" ? "PAUSED" : "ACTIVE", dailyBudget: action === "scale" ? Math.round(c.budget * 1.2) : c.budget } }),
      source: "rule_engine", status: "executed", reason, executed_at: new Date(Date.now() - ago * 864e5 - R() * 864e5).toISOString(), created_at: new Date(Date.now() - ago * 864e5 - R() * 864e5).toISOString() };
  });
  await chunked("bot_actions", logs);
}
for (let m = 0; m < 6; m++) {
  await sql`INSERT INTO manual_costs (line, date, name, amount) VALUES
    ('jasa', ${addDays(today, -(m * 30 + 8))}, '[demo] Fee freelancer developer', 1500000),
    ('digital', ${addDays(today, -(m * 30 + 15))}, '[demo] Refund pembeli', 149000)`;
}
await sql`UPDATE app_state SET value = to_jsonb((value::text)::bigint + 1) WHERE key = 'data_version'`;
await sql`ANALYZE`;
console.log("Seed demo selesai.");
await sql.end();
