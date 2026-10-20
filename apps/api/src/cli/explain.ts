// EXPLAIN (ANALYZE, BUFFERS) untuk query inti — hasilnya dicatat di docs/perf.md.
import { sql } from "../db";
const ids = (await sql`SELECT id FROM ad_accounts`).map((r) => r.id as string);
const [f, t, pf, pt] = ["2026-07-22", "2026-10-19", "2026-04-23", "2026-07-21"];
const qs: [string, string][] = [
  ["campaign_daily agregat (sekarang+pembanding)", `SELECT account_id, sum(spend) FILTER (WHERE date BETWEEN '${f}' AND '${t}'), sum(spend) FILTER (WHERE date BETWEEN '${pf}' AND '${pt}'), sum(clicks), sum(leads), sum(purchases), sum(purchase_value) FROM campaign_daily WHERE account_id = ANY('{${ids}}') AND date BETWEEN '${pf}' AND '${t}' GROUP BY account_id`],
  ["sales agregat per lini", `SELECT s.line, sum(s.revenue), sum(s.qty), sum(COALESCE(s.cogs, p.cogs * s.qty, 0)) FROM sales s LEFT JOIN products p ON p.id = s.product_id WHERE s.deleted_at IS NULL AND s.line = ANY('{digital,jasa}'::business_line[]) AND s.date BETWEEN '${pf}' AND '${t}' GROUP BY s.line`],
  ["account_hourly per jam", `SELECT hour, sum(spend), sum(purchases) FROM account_hourly WHERE account_id = ANY('{${ids}}') AND date BETWEEN '${f}' AND '${t}' GROUP BY hour`],
];
for (const [name, q] of qs) {
  const plan = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${q}`);
  console.log(`\n### ${name}\n` + plan.map((r: any) => r["QUERY PLAN"]).join("\n"));
}
await sql.end();
