// Bentuk respons API, dipakai bersama oleh backend & frontend.
import type { Kpis, Line } from "./metrics";
import type { AccountSettings, Rec } from "./rules";
import type { RangePreset } from "./dates";

export type Role = "owner" | "admin";
export type BotMode = "off" | "suggest" | "auto";

export interface User { id: number; email: string; name: string; role: Role }

export interface Account {
  id: string;
  name: string;
  line: Line;
  resultActionType: string;
  botMode: BotMode;
  active: boolean;
  timezone: string;
  lastSyncedAt: string | null;
  settings: AccountSettings;
}

export interface Product { id: number; line: Line; name: string; price: number | null; cogs: number; url: string | null; active: boolean }
export interface FixedCost { id: number; line: Line; name: string; monthly: number }
export interface LineSetting { line: Line; feePct: number }

export interface IntegrationStatus {
  metaConfigured: boolean;
  /** Jalur ke Meta: "mcp" = login Claude Code di VPS, "graph" = System User token, "none" = belum terhubung. */
  metaMode: "mcp" | "graph" | "none";
  metaTokenExpiresAt: string | null;
  metaError: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lynkConfigured: boolean;
  lastLynkAt: string | null;
  aiConfigured: boolean;
}

export interface Bootstrap {
  user: User;
  today: string;
  hourNow: number;
  dataVersion: number;
  accounts: Account[];
  products: Product[];
  fixedCosts: FixedCost[];
  lineSettings: LineSetting[];
  integration: IntegrationStatus;
}

/** acc = "all" | "digital" | "jasa" | <accountId> */
export interface RangeQuery { acc: string; from: string; to: string }

export interface Insight { tone: "good" | "bad" | "warn" | "info"; title: string; text: string }

export interface SeriesPoint { label: string; spend: number; revenue: number; roas: number; results: number; leads: number }

export interface DashboardResp {
  range: { from: string; to: string; prevFrom: string; prevTo: string; days: number };
  scope: { lines: Line[]; accountIds: string[]; hasLeads: boolean; hasDigital: boolean };
  kpis: Kpis;
  prev: Kpis;
  series: { granularity: "day" | "hour"; points: SeriesPoint[] };
  insights: Insight[];
  revenueByLine: { line: Line; revenue: number }[];
  campaignStatus: { active: number; paused: number };
  targetRoas: number;
}

export interface CampaignRow {
  id: string;
  name: string;
  accountId: string;
  accountName: string;
  line: Line;
  status: string;
  dailyBudget: number | null;
  spend: number; impressions: number; clicks: number; leads: number; purchases: number; revenue: number;
  revenueEstimated: boolean;
  ctr: number; cpc: number; cpl: number | null; cpa: number | null; roas: number;
  rec: Rec;
}
export interface CampaignsResp { rows: CampaignRow[]; hasLeads: boolean; multiAccount: boolean; singleDay: boolean }

export interface HourRow { hour: number; spend: number; clicks: number; leads: number; purchases: number; results: number; cost: number | null }
export interface HourlyResp { metric: "leads" | "purchases"; hours: HourRow[]; best: HourRow[]; worst: HourRow[]; hasLeads: boolean; hasDigital: boolean }

export interface ProductRow { key: string; name: string; line: Line; url: string | null; price: number; qty: number; revenue: number; cogs: number; share: number }
export interface ProductsResp { rows: ProductRow[]; total: { qty: number; revenue: number; cogs: number } }

export interface PlColumn { key: Line | "total"; label: string; src: string; kpis: Kpis; prevNet: number | null }
export interface PlResp {
  range: { from: string; to: string; prevFrom: string; prevTo: string; days: number };
  columns: PlColumn[];
  otherItems: { id: number; date: string; line: Line; name: string; amount: number }[];
}

export interface ManualItem {
  kind: "sale" | "cost";
  id: number;
  date: string;
  line: Line;
  title: string;
  amount: number;
  cogs: number | null;
  client: string | null;
  source: string | null;
  accountName: string | null;
  createdAt: string;
}
export interface ManualResp { items: ManualItem[]; nextCursor: string | null }

export interface BotAction {
  id: number;
  accountId: string | null;
  accountName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  action: string;
  params: Record<string, unknown>;
  source: "chat" | "table" | "rule_engine" | "autopilot";
  status: "pending" | "executed" | "failed" | "cancelled" | "expired" | "reverted";
  reason: string | null;
  error: string | null;
  createdAt: string;
  expiresAt: string | null;
  executedAt: string | null;
}
export interface BotResp { actions: BotAction[]; nextCursor: string | null }

/* ------------------------------------------------------------------ Autopilot Profit Engine */

export interface ProductUnitEcon {
  id: number;
  line: Line;
  name: string;
  price: number | null;
  cogs: number;
  platformFeePct: number;
  profitBeforeAds: number | null;
  maxBreakEvenCpa: number | null;
  breakEvenRoas: number | null;
  sold30d: number;
  revenue30d: number;
  url: string | null;
  assetCount: number;
}

export interface ProductAsset {
  id: number;
  productId: number;
  productName: string;
  line: Line;
  accountId: string | null;
  accountName: string | null;
  name: string;
  kind: "image" | "video" | "post";
  imageHash: string | null;
  imageUrl: string | null;
  videoId: string | null;
  thumbnailHash: string | null;
  objectStoryId: string | null;
  notes: string | null;
  timesUsed: number;
  active: boolean;
  createdAt: string;
}

export interface AgentPlSnapshot {
  todayNet: number;
  todaySpend: number;
  todayRevenue: number;
  todayRoas: number;
  net7d: number;
  spend7d: number;
  revenue7d: number;
  roas7d: number;
  beRoas7d: number;
  cpa7d: number;
  maxCpaBE7d: number;
  cpl7d: number;
  closeRate7d: number;
  net30d: number;
  roas30d: number;
  activeDailyBudget: number;
}

export interface AgentDecisionLog {
  kind: "pause_campaign" | "pause_ad" | "scale_campaign" | "inject_ads" | "launch_campaign" | "hold";
  targetName: string;
  campaignId?: string | null;
  adId?: string | null;
  productName?: string | null;
  angle?: string | null;
  rationale: string;
  status: "executed" | "pending" | "blocked_guardrail" | "skipped" | "failed";
  actionId?: number | null;
  detail?: string | null;
}

export interface AgentRun {
  id: number;
  accountId: string;
  accountName: string;
  line: Line;
  trigger: "sync" | "manual" | "chat";
  mode: BotMode;
  brain: "ai" | "deterministic";
  status: "running" | "completed" | "halted_guardrail" | "failed";
  plSnapshot: Partial<AgentPlSnapshot>;
  diagnosis: string | null;
  decisions: AgentDecisionLog[];
  guardrailNote: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface AgentMemory {
  id: number;
  accountId: string;
  accountName: string;
  productId: number | null;
  productName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  actionId: number | null;
  angle: string;
  headline: string | null;
  hookSummary: string | null;
  outcome: "testing" | "winning" | "losing" | "inconclusive";
  metrics: { spend?: number; results?: number; cpa?: number | null; roas?: number };
  lesson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutopilotAccountSummary {
  account: Account;
  pl: AgentPlSnapshot;
  activeCampaigns: number;
  launchesToday: number;
  stopLossTriggered: boolean;
  rejectionCircuitOpen: boolean;
  lastRunAt: string | null;
  lastRunStatus: AgentRun["status"] | null;
}

export interface AutopilotResp {
  accounts: AutopilotAccountSummary[];
  products: ProductUnitEcon[];
  assets: ProductAsset[];
  runs: AgentRun[];
  memories: AgentMemory[];
  recentActions: BotAction[];
}

/** Event dari server (SSE /api/events). */
export type ServerEvent =
  | { type: "version"; v: number }
  | { type: "sale"; amount: number; product: string }
  | { type: "sync"; status: string }
  | { type: "action"; id: number; status: string }
  | { type: "autopilot"; accountId: string; status: string };

/** Format angka di widget chat. */
export type WidgetFormat = "rp" | "x" | "pct" | "num";
export type WidgetTone = "good" | "bad" | "warn" | "neutral";

/** Widget data di chat. Selalu dibangun dari hasil tool (angka pasti), bukan ditulis model. */
export type ChatWidget =
  | {
      kind: "kpis"; title: string; subtitle?: string;
      items: { label: string; value: number | null; format: WidgetFormat; prev?: number | null; upIsGood?: boolean; hint?: string }[];
    }
  | {
      kind: "progress"; title: string; subtitle?: string;
      items: { label: string; value: number; target: number; format: WidgetFormat; hint?: string }[];
    }
  | {
      kind: "bars"; title: string; subtitle?: string; format: WidgetFormat;
      items: { label: string; value: number; sub?: string; tone?: WidgetTone }[];
    };

/** Foto/video yang dilampirkan di chat. Filenya sementara di disk server (bukan database) sampai diterima Meta. */
export interface ChatAttachment { id: string; kind: "image" | "video"; name: string; size: number; mime: string }

/** Video iklan buatan bot (kartu pratinjau di chat). */
export type CreativeStatus = "queued" | "rendering" | "review" | "approved" | "uploading" | "launching" | "launched" | "failed" | "discarded" | "expired";
export interface CreativeRun {
  id: number; status: CreativeStatus; progress: number; note: string | null; error: string | null;
  accountId: string; accountName: string;
  brief: { hook: string; bullets: string[]; priceBadge?: string; cta: string; script: string };
  plan: { campaignName: string; objective: string; dailyBudget: number; startNow: boolean; primaryText: string; headline: string; cta: string; linkUrl?: string };
  voice: { provider: "elevenlabs" | "none"; speechSec: number } | null;
  qc: { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] } | null;
  result: { bytes: number; durationSec: number; width: number; height: number } | null;
  action: { id: number; status: string; campaignId: string | null; error: string | null } | null;
  hasVideo: boolean; createdAt: string;
}

/** Baris yang dibaca bot untuk tiap lampiran (dipakai server & riwayat chat di browser supaya formatnya sama). */
export const attachmentLine = (a: ChatAttachment) =>
  `[Lampiran ${a.kind === "video" ? "video" : "foto"} · media_id=${a.id} · ${a.name} · ${(a.size / 1048576).toFixed(1).replace(".", ",")} MB]`;

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "widget"; widget: ChatWidget }
  | { type: "view"; acc?: string; preset?: RangePreset; from?: string; to?: string }
  | { type: "action_card"; action: BotAction }
  | { type: "video_card"; runId: number }
  | { type: "rule_changed"; accountId: string }
  | { type: "error"; message: string }
  | { type: "done" };
