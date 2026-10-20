// Runner migrasi SQL sederhana. Dikunci advisory lock supaya aman kalau dua proses boot bersamaan.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { sql } from "./db";
import { log } from "./log";

function migrationsDir() {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(process.cwd(), "migrations"),
    path.resolve(process.cwd(), "../../db/migrations"),
    path.resolve(process.cwd(), "db/migrations"),
  ].filter(Boolean) as string[];
  const dir = candidates.find((d) => existsSync(d));
  if (!dir) throw new Error("Folder migrasi tidak ditemukan");
  return dir;
}

export async function migrate() {
  const dir = migrationsDir();
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(724001)`;
    await tx`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set((await tx`SELECT name FROM _migrations`).map((r) => r.name as string));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      await tx.unsafe(await readFile(path.join(dir, f), "utf8"));
      await tx`INSERT INTO _migrations (name) VALUES (${f})`;
      log.info("migrasi diterapkan", { file: f });
    }
  });
}
