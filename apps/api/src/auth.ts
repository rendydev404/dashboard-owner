import { hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { Role, User } from "@iklan/shared";
import { sql } from "./db";
import { isProd } from "./env";

const COOKIE = isProd ? "__Host-sid" : "sid";
const SESSION_DAYS = 30;

export const hashPassword = (pw: string) => hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (h: string, pw: string) => verify(h, pw).catch(() => false);

export type AppEnv = { Variables: { user: User } };

export async function createSession(c: Context, userId: number) {
  const id = randomBytes(32).toString("base64url");
  await sql`INSERT INTO sessions (id, user_id, expires_at) VALUES (${id}, ${userId}, now() + make_interval(days => ${SESSION_DAYS}))`;
  setCookie(c, COOKIE, id, { httpOnly: true, secure: isProd, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
}

export async function destroySession(c: Context) {
  const id = getCookie(c, COOKIE);
  if (id) await sql`DELETE FROM sessions WHERE id = ${id}`;
  deleteCookie(c, COOKIE, { path: "/", secure: isProd });
}

// Sesi di-cache sebentar di memori supaya tiap request tidak selalu kena DB.
const sessionCache = new Map<string, { user: User; at: number }>();
const SESSION_CACHE_MS = 30_000;

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = getCookie(c, COOKIE);
  if (!id) throw new HTTPException(401, { message: "Belum login" });
  const hit = sessionCache.get(id);
  if (hit && Date.now() - hit.at < SESSION_CACHE_MS) {
    c.set("user", hit.user);
    return next();
  }
  const [row] = await sql`
    SELECT u.id, u.email, u.name, u.role, s.expires_at < now() + interval '29 days' AS stale
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${id} AND s.expires_at > now()`;
  if (!row) {
    sessionCache.delete(id);
    throw new HTTPException(401, { message: "Sesi habis, silakan login lagi" });
  }
  // Sesi geser: perpanjang paling sering sekali sehari.
  if (row.stale) {
    await sql`UPDATE sessions SET expires_at = now() + make_interval(days => ${SESSION_DAYS}) WHERE id = ${id}`;
    setCookie(c, COOKIE, id, { httpOnly: true, secure: isProd, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
  }
  const user: User = { id: Number(row.id), email: row.email, name: row.name, role: row.role };
  sessionCache.set(id, { user, at: Date.now() });
  c.set("user", user);
  return next();
};

export const forgetSession = (c: Context) => {
  const id = getCookie(c, COOKIE);
  if (id) sessionCache.delete(id);
};

export const requireRole = (role: Role): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (c.get("user").role !== role) throw new HTTPException(403, { message: "Hanya owner yang boleh melakukan ini" });
  return next();
};

/** Tolak request tulis dari origin lain (CSRF), selain webhook. */
export const sameOrigin: MiddlewareHandler = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
    if (origin && host) {
      const o = new URL(origin);
      // Dev: web di :5173 (proxy Vite) memanggil API di :3000, jadi origin localhost mana pun boleh.
      const devLocal = !isProd && ["localhost", "127.0.0.1"].includes(o.hostname);
      if (o.host !== host && !devLocal) throw new HTTPException(403, { message: "Origin tidak diizinkan" });
    }
  }
  return next();
};

/** Rate limit sederhana di memori (per kunci, jendela tetap). */
export function rateLimit(limit: number, windowMs: number, keyFn: (c: Context) => string): MiddlewareHandler {
  const hits = new Map<string, { n: number; reset: number }>();
  return async (c, next) => {
    const k = keyFn(c), now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
    if (++h.n > limit) {
      c.header("Retry-After", String(Math.ceil((h.reset - now) / 1000)));
      throw new HTTPException(429, { message: "Terlalu banyak percobaan, coba lagi sebentar" });
    }
    if (hits.size > 5000) for (const [key, v] of hits) if (v.reset < now) hits.delete(key);
    return next();
  };
}
export const clientIp = (c: Context) =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";
