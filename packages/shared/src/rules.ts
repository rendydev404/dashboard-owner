// Aturan rekomendasi bot per kampanye (PRD F8).
import { div, type Line } from "./metrics";

export interface AccountSettings {
  targetRoas: number;
  maxCpa: number | null;
  maxCpl: number | null;
  adTaxPct: number;
  scaleStepPct: number;
  killAfterSpend: number;
  maxDailyBudget: number | null;
}

export const DEFAULT_SETTINGS: Record<Line, AccountSettings> = {
  digital: { targetRoas: 2.5, maxCpa: 45000, maxCpl: null, adTaxPct: 3, scaleStepPct: 20, killAfterSpend: 100000, maxDailyBudget: null },
  jasa: { targetRoas: 4, maxCpa: 1500000, maxCpl: 60000, adTaxPct: 3, scaleStepPct: 20, killAfterSpend: 300000, maxDailyBudget: null },
};

export type RecCode = "inactive" | "kill" | "scale" | "creative" | "keep";
export type Tone = "gray" | "red" | "green" | "yellow" | "neutral";
export interface Rec { code: RecCode; label: string; tone: Tone }

export interface CampaignPerf {
  status: string; // ACTIVE | PAUSED | ...
  spend: number; purchases: number; leads: number;
  /** Nilai hasil kampanye: pixel (digital) atau estimasi omzet dari leads (jasa). */
  revenue: number;
}

export function recFor(c: CampaignPerf, line: Line, st: AccountSettings): Rec {
  if (c.status !== "ACTIVE") return { code: "inactive", label: "Nonaktif", tone: "gray" };
  const roas = div(c.revenue, c.spend);
  const cpa = c.purchases ? c.spend / c.purchases : Infinity;
  const cpl = c.leads ? c.spend / c.leads : Infinity;
  const jasa = line === "jasa";
  const overLimit = jasa ? st.maxCpl != null && cpl > st.maxCpl : st.maxCpa != null && cpa > st.maxCpa;
  if (c.spend >= st.killAfterSpend && overLimit) return { code: "kill", label: "Matikan", tone: "red" };
  if (c.spend > 0 && roas >= st.targetRoas * 1.3) return { code: "scale", label: `Scale +${st.scaleStepPct}%`, tone: "green" };
  // Kreatif baru boleh divonis setelah spend minimal seharga satu hasil yang diharapkan (batas CPL/CPA akun).
  const evidence = (jasa ? st.maxCpl : st.maxCpa) ?? st.killAfterSpend / 2;
  const failing = jasa ? overLimit : c.spend > 0 && roas < st.targetRoas;
  if (failing && c.spend < evidence) return { code: "keep", label: "Kumpulkan data", tone: "neutral" };
  if (failing) return { code: "creative", label: "Ganti kreatif", tone: "yellow" };
  return { code: "keep", label: "Pertahankan", tone: "neutral" };
}
