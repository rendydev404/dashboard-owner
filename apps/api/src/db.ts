import postgres from "postgres";
import { env } from "./env";
import { emit } from "./events";

export const sql = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  idle_timeout: 30,
  connect_timeout: 10,
  // int8 & numeric (hasil SUM) → number. Nilai rupiah aman jauh di bawah 2^53.
  types: {
    int8: { to: 20, from: [20], parse: (x: string) => Number(x), serialize: (x: number) => String(x) },
    numeric: { to: 1700, from: [1700], parse: (x: string) => Number(x), serialize: (x: number) => String(x) },
  },
  transform: { undefined: null },
  onnotice: () => {},
});

export const n = (v: unknown): number => (v == null ? 0 : Number(v));

let cachedVersion = 0;
export const dataVersion = () => cachedVersion;

export async function loadDataVersion() {
  const [r] = await sql`SELECT value FROM app_state WHERE key = 'data_version'`;
  cachedVersion = Number(r?.value ?? 1);
  return cachedVersion;
}

/** Naikkan versi data → cache server invalid & client diberi tahu lewat SSE. */
export async function bumpDataVersion() {
  const [r] = await sql`
    UPDATE app_state SET value = to_jsonb((value::text)::bigint + 1)
    WHERE key = 'data_version' RETURNING value`;
  cachedVersion = Number(r.value);
  emit({ type: "version", v: cachedVersion });
  return cachedVersion;
}

/**
 * Pantau nomor versi data di database (tiap 5 dtk). Perubahan yang dibuat di luar proses ini (skrip CLI, impor riwayat,
 * instance lain) otomatis membuat cache server tidak terpakai dan dashboard yang terbuka diberi tahu lewat SSE.
 */
export function startVersionWatcher() {
  setInterval(async () => {
    try {
      const prev = cachedVersion;
      const v = await loadDataVersion();
      if (v !== prev) emit({ type: "version", v });
    } catch { /* DB sedang tidak terjangkau; coba lagi 5 dtk lagi */ }
  }, 5_000).unref();
}
