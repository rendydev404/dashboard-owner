import { serve } from "@hono/node-server";
import { env } from "./env";
import { sql, loadDataVersion, startVersionWatcher } from "./db";
import { migrate } from "./migrate";
import { app } from "./app";
import { startScheduler } from "./scheduler";
import { log } from "./log";

await migrate();
await loadDataVersion();
const server = serve({ fetch: app.fetch, port: env.PORT }, (i) => log.info("server jalan", { port: i.port, env: env.NODE_ENV }));
startScheduler();
startVersionWatcher();

const shutdown = async () => {
  log.info("mematikan server");
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
