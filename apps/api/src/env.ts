import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().default(5),
  SESSION_SECRET: z.string().min(16).default("dev-secret-ganti-di-produksi"),
  META_API_VERSION: z.string().default("v24.0"),
  META_APP_SECRET: z.string().optional(),
  META_SYSTEM_USER_TOKEN: z.string().optional(),
  // Jembatan MCP: token OAuth dari login Claude Code user `claude-ads` di VPS (lihat meta/mcp.ts).
  META_MCP_CRED: z.string().default("/var/lib/claude-ads/.claude/.credentials.json"),
  META_MCP_URL: z.string().default("https://mcp.facebook.com/ads"),
  META_BRIDGE: z.enum(["auto", "mcp", "graph"]).default("auto"),
  LYNK_MERCHANT_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-sonnet-5-5"),
  // Jembatan Claude Code di host (deploy/claude-bridge.mjs): bot memakai login Claude user claude-ads, tanpa API key.
  CLAUDE_BRIDGE_URL: z.string().url().optional(),
  CLAUDE_BRIDGE_TOKEN: z.string().min(24).optional(),
  // URL tool dashboard (server MCP internal) dari sisi host tempat jembatan berjalan.
  CLAUDE_MCP_URL: z.string().url().default("http://127.0.0.1:3210/internal/mcp"),
  SYNC_INTERVAL_MIN: z.coerce.number().default(30),
  SYNC_ENABLED: z.enum(["true", "false"]).default("true"),
  CHAT_RATE_PER_HOUR: z.coerce.number().default(60),
  STATIC_DIR: z.string().default("public"),
  // Folder sementara foto/video lampiran chat (harus di disk, bukan tmpfs: video bisa 100 MB). Kosong = folder temp OS.
  MEDIA_DIR: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Env tidak valid:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
if (isProd && env.SESSION_SECRET.startsWith("dev-")) {
  console.error("SESSION_SECRET wajib diisi di produksi");
  process.exit(1);
}
import { existsSync } from "node:fs";
export type MetaMode = "mcp" | "graph" | "none";
/** Pilih jalur ke Meta: MCP (token login Claude Code) lebih diutamakan, Graph API (System User token) sebagai cadangan. */
export function metaMode(): MetaMode {
  const mcp = existsSync(env.META_MCP_CRED), graph = !!env.META_SYSTEM_USER_TOKEN;
  if (env.META_BRIDGE === "mcp") return mcp ? "mcp" : "none";
  if (env.META_BRIDGE === "graph") return graph ? "graph" : "none";
  return mcp ? "mcp" : graph ? "graph" : "none";
}
export const metaConfigured = () => metaMode() !== "none";
export type AiMode = "bridge" | "api" | "none";
/** Jembatan Claude Code diutamakan (pakai langganan Claude di VPS), API key Anthropic sebagai cadangan. */
export const aiMode = (): AiMode => (env.CLAUDE_BRIDGE_URL && env.CLAUDE_BRIDGE_TOKEN ? "bridge" : env.ANTHROPIC_API_KEY ? "api" : "none");
export const aiConfigured = () => aiMode() !== "none";
export const lynkConfigured = () => !!env.LYNK_MERCHANT_KEY;
