// Postgres lokal untuk development tanpa Docker (binary Postgres 17 asli via embedded-postgres).
// Data di .pgdata/. Koneksi: postgres://postgres:postgres@127.0.0.1:54329/postgres
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const req = createRequire(path.join(root, "apps/api/package.json"));
const { default: EmbeddedPostgres } = await import(pathToFileURL(req.resolve("embedded-postgres")).href);

const port = Number(process.env.DEV_DB_PORT || 54329);
const dir = path.join(root, ".pgdata");
const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: true, onLog: () => {} });
if (!existsSync(path.join(dir, "PG_VERSION"))) await pg.initialise();
await pg.start();
console.log(`dev-db siap: postgres://postgres:postgres@127.0.0.1:${port}/postgres`);
const stop = async () => { await pg.stop(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
