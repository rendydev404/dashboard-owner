// Webhook lynk.id (PLANNING §6). Signature = sha256_hex(grandTotal + refId + message_id + merchantKey).
import { createHash, timingSafeEqual } from "node:crypto";
import { sql, bumpDataVersion } from "./db";
import { env } from "./env";
import { emit } from "./events";
import { log, errMsg } from "./log";

export interface LynkItem { uuid?: string; title?: string; price?: number | string; qty?: number; addons?: { price?: string | number }[] }
export interface LynkPayload {
  event?: string;
  data?: {
    message_action?: string;
    message_id?: string;
    message_data?: {
      createdAt?: string;
      refId?: string;
      items?: LynkItem[];
      totals?: { grandTotal?: number | string; totalPrice?: number | string; totalAddon?: number | string; totalShipping?: number | string };
    };
  };
}

/** Ambil teks grandTotal persis seperti di JSON mentah (hindari 72000 vs 72000.0). */
export function rawGrandTotal(raw: string, parsed: unknown): string {
  const m = raw.match(/"grandTotal"\s*:\s*"?([-\d.]+)"?/);
  return m ? m[1] : String(parsed ?? "");
}

export function lynkSignature(grandTotal: string, refId: string, messageId: string, key: string) {
  return createHash("sha256").update(grandTotal + refId + messageId + key).digest("hex");
}

export function verifySignature(received: string | undefined, expected: string) {
  if (!received) return false;
  const a = Buffer.from(received.trim().toLowerCase()), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const num = (v: unknown) => Number(String(v ?? "").replace(/[^\d.-]/g, "")) || 0;

/** Bagi grandTotal ke item secara proporsional; sisa pembulatan masuk item terakhir (Σ = grandTotal). */
export function splitRevenue(items: LynkItem[], grandTotal: number): number[] {
  const weights = items.map((it) => num(it.price) * (it.qty || 1) + (it.addons ?? []).reduce((t, a) => t + num(a.price), 0));
  const total = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => (total ? Math.floor((grandTotal * w) / total) : Math.floor(grandTotal / items.length)));
  out[out.length - 1] += grandTotal - out.reduce((a, b) => a + b, 0);
  return out;
}

/** createdAt lynk tanpa zona waktu → dianggap WIB. */
export function lynkDate(createdAt: string | undefined): { date: string; at: string } {
  if (createdAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(createdAt)) {
    const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(createdAt);
    const at = new Date(hasTz ? createdAt : createdAt + "+07:00");
    const date = new Date(at.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
    return { date, at: at.toISOString() };
  }
  const now = new Date();
  return { date: new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10), at: now.toISOString() };
}

export type WebhookResult = { status: 200 | 400 | 401 | 500 | 503; body: Record<string, unknown> };

export async function handleLynkWebhook(raw: string, signature: string | undefined): Promise<WebhookResult> {
  if (!env.LYNK_MERCHANT_KEY) return { status: 503, body: { ok: false, error: "Webhook belum dikonfigurasi" } };
  let p: LynkPayload;
  try { p = JSON.parse(raw); } catch { return { status: 400, body: { ok: false, error: "JSON tidak valid" } }; }
  const d = p.data, md = d?.message_data;
  const messageId = d?.message_id, refId = md?.refId;
  if (!messageId || !refId || md?.totals?.grandTotal == null) return { status: 400, body: { ok: false, error: "Field wajib tidak ada" } };

  const gt = rawGrandTotal(raw, md.totals.grandTotal);
  const ok = verifySignature(signature, lynkSignature(gt, refId, messageId, env.LYNK_MERCHANT_KEY));

  // Event yang sama boleh datang lagi (retry lynk). Kalau dulu gagal diproses, proses ulang; kalau sudah, abaikan.
  const [ev] = await sql`
    INSERT INTO lynk_events (message_id, ref_id, event, signature_ok, payload)
    VALUES (${messageId}, ${refId}, ${p.event ?? "unknown"}, ${ok}, ${sql.json(p as any)})
    ON CONFLICT (message_id) DO UPDATE SET signature_ok = lynk_events.signature_ok OR EXCLUDED.signature_ok
    RETURNING processed_at`;
  if (ev.processed_at) return { status: 200, body: { ok: true, duplicate: true } };
  if (!ok) {
    log.warn("lynk signature tidak cocok", { messageId });
    return { status: 401, body: { ok: false, error: "Signature tidak valid" } };
  }
  if (d.message_action !== "SUCCESS" || p.event !== "payment.received") {
    await sql`UPDATE lynk_events SET processed_at = now() WHERE message_id = ${messageId}`;
    return { status: 200, body: { ok: true, ignored: true } };
  }

  try {
    const items = (md.items?.length ? md.items : [{ title: "Produk lynk.id", price: num(gt), qty: 1 }]) as LynkItem[];
    const revs = splitRevenue(items, Math.round(num(gt)));
    // Omzet kotor (dasar PPN lynk 3%): totalPrice + totalAddon + totalShipping, dibagi ke item dengan bobot yang sama.
    const t = md.totals ?? {};
    const grossTotal = Math.round(num(t.totalPrice) + num(t.totalAddon) + num(t.totalShipping));
    const grosses = grossTotal > 0 ? splitRevenue(items, grossTotal) : revs;
    const { date, at } = lynkDate(md.createdAt);
    await sql.begin(async (tx) => {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const name = (it.title || "Produk lynk.id").slice(0, 200);
        const price = Math.round(num(it.price)) || null;
        // Cocokkan produk lewat uuid lynk dulu, lalu nama (produk bisa sudah dibuat manual di Pengaturan).
        let [prod] = await tx`
          SELECT id FROM products
          WHERE (${it.uuid ?? null}::text IS NOT NULL AND lynk_uuid = ${it.uuid ?? null}) OR (line = 'digital' AND name = ${name})
          ORDER BY (lynk_uuid = ${it.uuid ?? ""}) DESC NULLS LAST LIMIT 1`;
        if (prod) {
          await tx`UPDATE products SET lynk_uuid = COALESCE(lynk_uuid, ${it.uuid ?? null}), price = COALESCE(${price}, price) WHERE id = ${prod.id}`;
        } else {
          [prod] = await tx`INSERT INTO products (line, name, price, lynk_uuid) VALUES ('digital', ${name}, ${price}, ${it.uuid ?? null}) RETURNING id`;
        }
        await tx`
          INSERT INTO sales (line, product_id, product_name, date, occurred_at, qty, revenue, gross, source, channel, lynk_ref_id, lynk_item_ix)
          VALUES ('digital', ${prod.id}, ${name}, ${date}, ${at}, ${it.qty || 1}, ${revs[i]}, ${grosses[i]}, 'lynk', 'lynk', ${refId}, ${i})
          ON CONFLICT (lynk_ref_id, lynk_item_ix) DO NOTHING`;
      }
      await tx`UPDATE lynk_events SET processed_at = now() WHERE message_id = ${messageId}`;
    });
    await bumpDataVersion();
    emit({ type: "sale", amount: Math.round(num(gt)), product: items.map((x) => x.title).filter(Boolean).join(", ") });
    log.info("penjualan lynk masuk", { refId, amount: gt });
    return { status: 200, body: { ok: true } };
  } catch (e) {
    await sql`UPDATE lynk_events SET error = ${errMsg(e)} WHERE message_id = ${messageId}`;
    log.error("gagal proses lynk", { messageId, error: errMsg(e) });
    // 500 → lynk mengirim ulang; event mentah tersimpan dan insert penjualan idempoten.
    return { status: 500, body: { ok: false, stored: true } };
  }
}
