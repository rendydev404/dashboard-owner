// Klien Meta Graph API (Marketing API) dengan System User token.
import { createHmac } from "node:crypto";
import { env } from "../env";
import { log } from "../log";

export class MetaError extends Error {
  constructor(message: string, public code?: number, public subcode?: number, public status?: number) { super(message); }
  get isRateLimit() { return [4, 17, 32, 613, 80000, 80003, 80004, 80014].includes(this.code ?? 0); }
  get isAuth() { return this.code === 190 || this.code === 102; }
}

const base = () => `https://graph.facebook.com/${env.META_API_VERSION}`;
const proof = () => env.META_APP_SECRET
  ? createHmac("sha256", env.META_APP_SECRET).update(env.META_SYSTEM_USER_TOKEN!).digest("hex")
  : undefined;

/** Pemakaian kuota tertinggi dari header (0–100), untuk menunda sync kalau mendekati batas. */
export let lastUsagePct = 0;
function readUsage(h: Headers) {
  let max = 0;
  for (const name of ["x-business-use-case-usage", "x-ad-account-usage", "x-app-usage"]) {
    const v = h.get(name);
    if (!v) continue;
    const nums = v.match(/"(?:call_count|total_cputime|total_time|acc_id_util_pct)"\s*:\s*(\d+(?:\.\d+)?)/g) ?? [];
    for (const m of nums) max = Math.max(max, Number(m.split(":")[1]));
  }
  lastUsagePct = max;
}

async function request(method: "GET" | "POST", path: string, params: Record<string, string | number | undefined>, attempt = 0): Promise<any> {
  if (!env.META_SYSTEM_USER_TOKEN) throw new MetaError("Token Meta belum diisi (META_SYSTEM_USER_TOKEN)");
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  q.set("access_token", env.META_SYSTEM_USER_TOKEN);
  const p = proof();
  if (p) q.set("appsecret_proof", p);
  const url = path.startsWith("http") ? path : `${base()}/${path}`;
  const res = await fetch(method === "GET" ? `${url}${url.includes("?") ? "&" : "?"}${q}` : url, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
    body: method === "POST" ? q : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  readUsage(res.headers);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const e = body.error ?? {};
    const err = new MetaError(e.error_user_msg || e.message || `HTTP ${res.status}`, e.code, e.error_subcode, res.status);
    if ((err.isRateLimit || res.status >= 500) && attempt < 4) {
      const wait = 2 ** attempt * 60_000 * (err.isRateLimit ? 1 : 0.05);
      log.warn("meta retry", { path, code: err.code, wait });
      await new Promise((r) => setTimeout(r, wait));
      return request(method, path, params, attempt + 1);
    }
    throw err;
  }
  return body;
}

export const metaGet = (path: string, params: Record<string, string | number | undefined> = {}) => request("GET", path, params);
export const metaPost = (path: string, params: Record<string, string | number | undefined>) => request("POST", path, params);

/** Ambil semua halaman (paging.next). */
export async function metaGetAll<T = any>(path: string, params: Record<string, string | number | undefined> = {}, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  let body = await metaGet(path, { limit: 500, ...params });
  for (let i = 0; i < maxPages; i++) {
    out.push(...(body.data ?? []));
    const next = body.paging?.next;
    if (!next) break;
    const u = new URL(next);
    const after = u.searchParams.get("after");
    if (!after) break;
    body = await metaGet(path, { limit: 500, ...params, after });
  }
  return out;
}

type ActionList = { action_type: string; value: string }[] | undefined;
export function actionValue(list: ActionList, types: string[]): number {
  if (!list) return 0;
  for (const t of types) {
    const hit = list.find((a) => a.action_type === t);
    if (hit) return Math.round(Number(hit.value) || 0);
  }
  return 0;
}
export const PURCHASE_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
