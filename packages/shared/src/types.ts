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
  source: "chat" | "table" | "rule_engine";
  status: "pending" | "executed" | "failed" | "cancelled" | "expired" | "reverted";
  reason: string | null;
  error: string | null;
  createdAt: string;
  expiresAt: string | null;
  executedAt: string | null;
}
export interface BotResp { actions: BotAction[]; nextCursor: string | null }

/** Event dari server (SSE /api/events). */
export type ServerEvent =
  | { type: "version"; v: number }
  | { type: "sale"; amount: number; product: string }
  | { type: "sync"; status: string }
  | { type: "action"; id: number; status: string };

/** Event stream dari /api/chat. */
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "view"; acc?: string; preset?: RangePreset; from?: string; to?: string }
  | { type: "action_card"; action: BotAction }
  | { type: "rule_changed"; accountId: string }
  | { type: "error"; message: string }
  | { type: "done" };
