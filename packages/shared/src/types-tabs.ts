// Bentuk respons untuk tab "Facebook Ads" dan "lynk.id" di halaman Ringkasan.
import type { Line } from "./metrics";
import type { CampaignRow } from "./types";

export interface FbKpis {
  spend: number; impressions: number; clicks: number; ctr: number; cpc: number; cpm: number;
  purchases: number; purchaseValue: number; roas: number; cpa: number; leads: number; cpl: number;
}
export interface FbPoint { label: string; spend: number; impressions: number; clicks: number; purchases: number; purchaseValue: number; leads: number }
export interface FbAccountRow { id: string; name: string; line: Line; spend: number; impressions: number; clicks: number; purchases: number; purchaseValue: number; leads: number; roas: number }
export interface FbResp {
  range: { from: string; to: string; prevFrom: string; prevTo: string; days: number };
  kpis: FbKpis; prev: FbKpis;
  series: { granularity: "day" | "hour"; points: FbPoint[] };
  accounts: FbAccountRow[];
  campaigns: CampaignRow[];
  hasLeads: boolean; hasDigital: boolean;
  lastSyncedAt: string | null;
}

export interface LynkKpis { orders: number; items: number; gross: number; discount: number; revenue: number; ppn: number; net: number; aov: number }
export interface LynkResp {
  range: { from: string; to: string; prevFrom: string; prevTo: string; days: number };
  kpis: LynkKpis; prev: LynkKpis;
  ppnPct: number;
  series: { granularity: "day" | "hour"; points: { label: string; orders: number; net: number }[] };
  hours: { hour: number; orders: number; revenue: number }[];
  products: { name: string; qty: number; revenue: number; share: number }[];
  recent: { at: string; product: string; qty: number; revenue: number }[];
  webhook: { configured: boolean; events: number; valid: number; invalid: number; lastAt: string | null };
}
