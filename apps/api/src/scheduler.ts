// Penjadwal in-process (cek tiap menit). Advisory lock di runSync mencegah job dobel saat redeploy.
import { hourNow, todayKey } from "@iklan/shared";
import { sql } from "./db";
import { env, metaConfigured } from "./env";
import { runSync } from "./meta/sync";
import { lastUsagePct } from "./meta/client";
import { log, errMsg } from "./log";

let lastRecent = 0;
let lastNightly = "";
let lastCleanup = "";
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const h = hourNow(), today = todayKey();
    if (metaConfigured() && env.SYNC_ENABLED === "true") {
      // Akun baru tanpa data → backfill 180 hari.
      const fresh = await sql`
        SELECT a.id FROM ad_accounts a
        WHERE a.active AND NOT EXISTS (SELECT 1 FROM campaign_daily d WHERE d.account_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM sync_runs r WHERE r.account_id = a.id AND r.kind = 'backfill' AND r.started_at > now() - interval '6 hours')`;
      for (const a of fresh) await runSync("backfill", a.id);

      if (h === 2 && lastNightly !== today) {
        lastNightly = today;
        await runSync("nightly");
      } else {
        const every = (h < 6 ? 120 : env.SYNC_INTERVAL_MIN) * 60_000;
        if (Date.now() - lastRecent >= every && lastUsagePct < 75) {
          lastRecent = Date.now();
          await runSync("recent");
        }
      }
    }
    if (h === 3 && lastCleanup !== today) {
      lastCleanup = today;
      await sql`DELETE FROM sessions WHERE expires_at < now()`;
      await sql`UPDATE bot_actions SET status = 'expired' WHERE status = 'pending' AND (expires_at IS NULL OR expires_at < now()) AND created_at < now() - interval '1 hour'`;
      await sql`DELETE FROM lynk_events WHERE received_at < now() - interval '180 days'`;
      log.info("cleanup harian selesai");
    }
  } catch (e) {
    log.error("scheduler", { error: errMsg(e) });
  } finally {
    busy = false;
  }
}

export function startScheduler() {
  setTimeout(tick, 5_000);
  setInterval(tick, 60_000).unref();
}
