// Autopilot Profit Engine: agen otonom berbasis Laba Bersih Riil (Net Profit) & Unit Economics.
// Siklus kerja: Rekonsiliasi Memori Eksperimen -> Bangun Dossier Bisnis & P&L Lengkap -> Evaluasi Guardrail Keselamatan
// -> Perencanaan Strategi AI (Claude) / Fallback Kuantitatif -> Audit Kebijakan Meta -> Eksekusi Atomik -> Catat Memori & Run.
import Anthropic from "@anthropic-ai/sdk";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  div, hourNow, rp, rpk, dec, LINES,
  type Account, type AccountSettings, type AgentDecisionLog, type AgentMemory, type AgentPlSnapshot,
  type AgentRun, type AutopilotAccountSummary, type AutopilotResp, type Line, type ProductAsset, type ProductUnitEcon,
} from "@iklan/shared";
import { aiConfigured, aiMode, env, metaConfigured, metaMode } from "./env";
import { bumpDataVersion, sql } from "./db";
import { loadConfig, resolveRange, resolveScope, type Config } from "./scope";
import * as Q from "./queries";
import { adBreakdown, diagnose } from "./analysis";
import { auditLaunchPlan, LAUNCH_CTAS, launchContext, type AdItem, type CreativeSpec } from "./meta/launch";
import { uploadAttachment } from "./meta/upload";
import {
  confirmAction, createAddAdsAction, createCampaignAction, createLaunchAction, createPauseAdAction, toAction,
} from "./actions";
import { closeChatSession, openChatSession } from "./chat-sessions";
import { emit } from "./events";
import { errMsg, log } from "./log";

export const CANONICAL_ANGLES = [
  "pain_agitation",
  "outcome_mechanism",
  "direct_offer",
  "qualification_proof",
  "contrarian_efficiency",
] as const;
export type CanonicalAngle = (typeof CANONICAL_ANGLES)[number];

export const ANGLE_LABELS: Record<string, string> = {
  pain_agitation: "Pain-Agitation-Solution",
  outcome_mechanism: "Outcome & Mekanisme",
  direct_offer: "Direct Offer & Value Stack",
  qualification_proof: "Kualifikasi & Bukti Nyata",
  contrarian_efficiency: "Efisiensi vs Cara Manual",
};

/* ------------------------------------------------------------------ 1. Unit Economics & Guardrail Murni */

export function computeProductUnitEconomics(input: {
  id: number;
  line: Line;
  name: string;
  price: number | null;
  cogs: number;
  url: string | null;
  sold30d: number;
  revenue30d: number;
  assetCount: number;
  feePct: number;
  adTaxPct: number;
}): ProductUnitEcon {
  const { price, cogs, feePct, adTaxPct } = input;
  const fee = price != null ? Math.round((price * feePct) / 100) : null;
  const profitBeforeAds = price != null && fee != null ? price - cogs - fee : null;
  const adTaxMult = 1 + (adTaxPct || 0) / 100;
  const maxBreakEvenCpa = profitBeforeAds != null && profitBeforeAds > 0 ? Math.floor(profitBeforeAds / adTaxMult) : null;
  const breakEvenRoas = price != null && profitBeforeAds != null && profitBeforeAds > 0
    ? Math.round(((price * adTaxMult) / profitBeforeAds) * 100) / 100
    : null;
  return {
    id: input.id,
    line: input.line,
    name: input.name,
    price,
    cogs,
    platformFeePct: feePct,
    profitBeforeAds,
    maxBreakEvenCpa,
    breakEvenRoas,
    sold30d: input.sold30d,
    revenue30d: input.revenue30d,
    url: input.url,
    assetCount: input.assetCount,
  };
}

export interface GuardrailContext {
  settings: AccountSettings;
  pl: AgentPlSnapshot;
  hourWib: number;
  launchesToday: number;
  failedLaunches7d: number;
  lastActionMsByCampaign: Map<string, number>;
  campaignAgeDays: Map<string, number>;
  nowMs?: number;
}

export interface GuardrailState {
  stopLossTriggered: boolean;
  rejectionCircuitOpen: boolean;
  deadHours: boolean;
  launchQuotaFull: boolean;
  remainingAccountBudget: number | null;
  notes: string[];
}

export function evaluateGuardrails(ctx: GuardrailContext): GuardrailState {
  const st = ctx.settings;
  const stopLossTriggered = st.dailyStopLoss != null && st.dailyStopLoss > 0
    && ctx.pl.todaySpend > 0 && ctx.pl.todayNet <= -st.dailyStopLoss;
  const rejectionCircuitOpen = ctx.failedLaunches7d >= 2;
  const deadHours = ctx.hourWib >= 0 && ctx.hourWib < 6;
  const launchQuotaFull = ctx.launchesToday >= st.maxAutoLaunchesPerDay;
  const remainingAccountBudget = st.maxAccountDailyBudget != null
    ? Math.max(0, st.maxAccountDailyBudget - ctx.pl.activeDailyBudget)
    : null;

  const notes: string[] = [];
  if (stopLossTriggered) {
    notes.push(`Stop-loss harian aktif: rugi bersih hari ini ${rp(Math.abs(ctx.pl.todayNet))} melewati batas ${rp(st.dailyStopLoss!)}. Hanya aksi penghentian kerugian (pause) yang diizinkan.`);
  }
  if (rejectionCircuitOpen) {
    notes.push(`Circuit breaker Meta aktif: terdeteksi ${ctx.failedLaunches7d} kegagalan peluncuran dalam 7 hari terakhir. Pembuatan iklan baru dihentikan sementara.`);
  }
  if (!st.autoLaunchEnabled) {
    notes.push("Fitur peluncuran iklan pengganti otomatis dinonaktifkan pada pengaturan akun.");
  } else if (launchQuotaFull) {
    notes.push(`Kuota peluncuran harian penuh (${ctx.launchesToday}/${st.maxAutoLaunchesPerDay} aksi hari ini).`);
  }
  if (deadHours) {
    notes.push("Jam sepi 00:00-05:59 WIB: kenaikan budget (scale) ditahan sampai jam produktif.");
  }
  return { stopLossTriggered, rejectionCircuitOpen, deadHours, launchQuotaFull, remainingAccountBudget, notes };
}

export function checkDecisionGuardrail(
  decision: {
    kind: AgentDecisionLog["kind"];
    campaignId?: string | null;
    dailyBudget?: number;
    currentDailyBudget?: number | null;
    scalePct?: number;
    spend?: number;
  },
  ctx: GuardrailContext,
  state = evaluateGuardrails(ctx),
): { ok: true; adjustedBudget?: number } | { ok: false; reason: string } {
  const st = ctx.settings;
  const now = ctx.nowMs ?? Date.now();

  if (decision.kind === "hold") return { ok: true };

  // Cek cooldown per kampanye agar algoritma tidak diutak-atik berulang kali dalam hitungan menit.
  if (decision.campaignId && st.cooldownHours > 0) {
    const lastMs = ctx.lastActionMsByCampaign.get(decision.campaignId);
    if (lastMs != null) {
      const elapsedHrs = (now - lastMs) / 3_600_000;
      const emergencyKill = (decision.kind === "pause_campaign" || decision.kind === "pause_ad")
        && state.stopLossTriggered && (decision.spend ?? 0) >= st.killAfterSpend;
      if (elapsedHrs < st.cooldownHours && !emergencyKill) {
        return {
          ok: false,
          reason: `Cooldown aktif (${Math.round(elapsedHrs * 10) / 10} jam berlalu dari minimal ${st.cooldownHours} jam sejak aksi terakhir di kampanye ini).`,
        };
      }
    }
  }

  // Proteksi masa belajar (learning window < 3 hari) kecuali sudah membakar spend >= killAfterSpend.
  if (decision.kind === "pause_campaign" && decision.campaignId) {
    const age = ctx.campaignAgeDays.get(decision.campaignId);
    if (age != null && age < 3 && (decision.spend ?? 0) < st.killAfterSpend) {
      return {
        ok: false,
        reason: `Kampanye baru berjalan ${age} hari dengan spend ${rpk(decision.spend ?? 0)} di bawah batas kill ${rpk(st.killAfterSpend)} (lindungi fase belajar).`,
      };
    }
  }

  // Aksi ofensif (scale / launch / inject) wajib tunduk pada stop-loss, jam mati, & batas anggaran.
  if (decision.kind === "scale_campaign") {
    if (state.stopLossTriggered) return { ok: false, reason: "Diblokir oleh stop-loss harian akun." };
    if (state.deadHours) return { ok: false, reason: "Diblokir pada jam sepi 00:00-05:59 WIB." };
    const cur = decision.currentDailyBudget ?? 0;
    const pct = Math.min(Math.max(decision.scalePct ?? st.scaleStepPct, 5), 50);
    const nextBudget = st.maxDailyBudget ? Math.min(Math.round(cur * (1 + pct / 100)), st.maxDailyBudget) : Math.round(cur * (1 + pct / 100));
    const deltaBudget = Math.max(0, nextBudget - cur);
    if (cur > 0 && deltaBudget === 0) {
      return { ok: false, reason: `Budget kampanye sudah mencapai batas maksimal ${rpk(st.maxDailyBudget ?? cur)}/hari.` };
    }
    if (state.remainingAccountBudget != null && deltaBudget > state.remainingAccountBudget) {
      return {
        ok: false,
        reason: `Kenaikan budget +${rpk(deltaBudget)} melewati sisa plafon total budget harian akun (${rpk(state.remainingAccountBudget)}).`,
      };
    }
    return { ok: true, adjustedBudget: nextBudget };
  }

  if (decision.kind === "launch_campaign" || decision.kind === "inject_ads") {
    if (state.stopLossTriggered) return { ok: false, reason: "Peluncuran ditahan karena stop-loss harian sedang aktif." };
    if (state.rejectionCircuitOpen) return { ok: false, reason: "Circuit breaker penolakan Meta sedang aktif (>= 2 gagal dalam 7 hari)." };
    if (!st.autoLaunchEnabled) return { ok: false, reason: "Auto-launch iklan baru sedang dinonaktifkan." };
    if (state.launchQuotaFull) return { ok: false, reason: `Kuota peluncuran otonom harian (${st.maxAutoLaunchesPerDay}/hari) sudah terpakai.` };

    if (decision.kind === "launch_campaign") {
      let budget = Math.round(decision.dailyBudget ?? 50_000);
      if (st.maxDailyBudget != null && budget > st.maxDailyBudget) budget = st.maxDailyBudget;
      if (state.remainingAccountBudget != null) {
        if (state.remainingAccountBudget < 20_000) {
          return { ok: false, reason: `Plafon total budget harian akun penuh (sisa ${rpk(state.remainingAccountBudget)}).` };
        }
        if (budget > state.remainingAccountBudget) budget = state.remainingAccountBudget;
      }
      return { ok: true, adjustedBudget: budget };
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ 2. Evaluasi Memori Eksperimen Angle */

export function evaluateExperimentOutcome(
  perf: { spend: number; impressions: number; clicks: number; results: number; revenue: number; ageDays: number },
  opts: { line: Line; settings: AccountSettings; maxBreakEvenCpa?: number | null },
): { outcome: AgentMemory["outcome"]; lesson: string | null } {
  const { line, settings: st } = opts;
  const targetCost = (line === "jasa" ? st.maxCpl : st.maxCpa) ?? opts.maxBreakEvenCpa ?? Math.round(st.killAfterSpend / 2);
  const breakEvenCost = opts.maxBreakEvenCpa ?? Math.round(targetCost * 1.25);
  const cpa = perf.results > 0 ? perf.spend / perf.results : Infinity;
  const roas = div(perf.revenue, perf.spend);
  const ctrPct = perf.impressions > 0 ? (perf.clicks * 100) / perf.impressions : 0;

  if (perf.results >= 3 && (cpa <= targetCost || (line === "digital" && roas >= st.targetRoas))) {
    return {
      outcome: "winning",
      lesson: `Angle profitabel: ${perf.results} hasil dengan biaya/hasil ${rpk(Math.round(cpa))} (target <= ${rpk(targetCost)}) dan CTR ${dec(ctrPct, 2)}%. Jadikan referensi utama saat scale.`,
    };
  }
  if (perf.spend >= st.killAfterSpend && (perf.results === 0 || cpa > breakEvenCost)) {
    const why = ctrPct < 1.0
      ? `CTR tautan rendah (${dec(ctrPct, 2)}% < 1%): hook pembuka gagal menghentikan scroll. Jangan ulang angle ini.`
      : `CTR ${dec(ctrPct, 2)}% cukup baik tetapi konversi pasca-klik lemah (${perf.results} hasil, CPA ${Number.isFinite(cpa) ? rpk(Math.round(cpa)) : "tak hingga"} > titik impas ${rpk(breakEvenCost)}): ganti sudut penawaran & kualifikasi harga.`;
    return { outcome: "losing", lesson: why };
  }
  if (perf.ageDays >= 14 && perf.spend < targetCost) {
    return {
      outcome: "inconclusive",
      lesson: `Impresi/spend terlalu kecil (${rpk(perf.spend)}) selama ${perf.ageDays} hari untuk mengambil kesimpulan statistik.`,
    };
  }
  return { outcome: "testing", lesson: null };
}

/** Pilih angle yang belum gagal/sedang diuji untuk suatu produk agar AI selalu bereksperimen maju sampai profit. */
export function selectNextAngles(
  memories: Pick<AgentMemory, "productId" | "angle" | "outcome">[],
  productId: number | null,
  count = 2,
): string[] {
  const relevant = memories.filter((m) => productId == null || m.productId === productId || m.productId == null);
  const tried = new Set(
    relevant
      .filter((m) => m.outcome === "losing" || m.outcome === "testing" || m.outcome === "winning")
      .map((m) => m.angle),
  );
  const winners = relevant.filter((m) => m.outcome === "winning").map((m) => m.angle);

  const fresh = CANONICAL_ANGLES.filter((a) => !tried.has(a));
  if (fresh.length >= count) return fresh.slice(0, count);

  const out: string[] = [...fresh];
  for (const w of winners) {
    const variant = `${w}_v2`;
    if (!tried.has(variant) && !out.includes(variant)) out.push(variant);
    if (out.length >= count) return out;
  }
  let iter = 2;
  while (out.length < count) {
    for (const base of CANONICAL_ANGLES) {
      const candidate = `${base}_iter${iter}`;
      if (!tried.has(candidate) && !out.includes(candidate)) out.push(candidate);
      if (out.length >= count) break;
    }
    iter++;
  }
  return out;
}

function shortProductTitle(name: string, maxLen = 18): string {
  const cleaned = name.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  const words = cleaned.split(" ");
  let acc = "";
  for (const w of words) {
    const next = acc ? `${acc} ${w}` : w;
    if (next.length > maxLen) break;
    acc = next;
  }
  return acc || cleaned.slice(0, maxLen).trim();
}

function fitHeadline(withPrice: string, fallback: string): string {
  if (withPrice.length <= 40) return withPrice;
  if (fallback.length <= 40) return fallback;
  return fallback.slice(0, 40).trim();
}

/** Tulis copy Direct-Response Bahasa Indonesia bebas pelanggaran kebijakan Meta & bebas emoji untuk setiap angle. */
export function synthesizeCompliantCopy(
  product: Pick<ProductUnitEcon, "name" | "line" | "price" | "profitBeforeAds" | "url">,
  angle: string,
): { adName: string; primaryText: string; headline: string; description: string; cta: (typeof LAUNCH_CTAS)[number] } {
  const baseAngle = CANONICAL_ANGLES.find((a) => angle.startsWith(a)) ?? "direct_offer";
  const priceText = product.price && product.price > 0 ? rpk(product.price) : null;
  const shortName = shortProductTitle(product.name, 18);

  if (product.line === "jasa") {
    const anchor = priceText ? ` Paket layanan transparan mulai ${priceText} sesuai cakupan kebutuhan bisnis.` : "";
    const variants: Record<CanonicalAngle, { primaryText: string; headline: string; label: string }> = {
      pain_agitation: {
        label: "Angle Efisiensi Operasional",
        primaryText:
          `Masih menghabiskan belasan jam kerja tim setiap minggu untuk proses manual yang berulang?\n\n` +
          `Layanan ${product.name} membantu merapikan alur kerja bisnis dengan sistem AI siap pakai tanpa perlu rekrut tim teknis baru.${anchor}\n\n` +
          `Konsultasikan kebutuhan spesifik bisnis lewat WhatsApp untuk melihat estimasi pengerjaan dan demo hasil kerja.`,
        headline: `Layanan ${shortName} Siap Pakai`.slice(0, 40),
      },
      outcome_mechanism: {
        label: "Angle Kecepatan Hasil",
        primaryText:
          `Percepat eksekusi produksi dan layanan pelanggan bisnis dengan implementasi ${product.name} yang terukur.\n\n` +
          `Tim spesialis mengerjakan setup dari awal sampai siap digunakan, lengkap dengan panduan operasional singkat bagi tim internal.${anchor}\n\n` +
          `Klik tombol WhatsApp di bawah untuk diskusi cakupan proyek bersama tim kami.`,
        headline: `${shortName} - Setup Cepat`.slice(0, 40),
      },
      direct_offer: {
        label: "Angle Paket Transparan",
        primaryText:
          `Butuh solusi ${product.name} yang langsung beres tanpa ribet urusan teknis sendiri?\n\n` +
          `Dapatkan pengerjaan profesional, revisi terarah, dan standar kualitas siap komersial untuk mendukung pertumbuhan omzet bisnis.${anchor}\n\n` +
          `Hubungi tim kami via WhatsApp sekarang untuk jadwal pengerjaan minggu ini.`,
        headline: priceText ? fitHeadline(`${shortName} Mulai ${priceText}`, `Konsultasi ${shortName}`) : `Konsultasi ${shortName}`.slice(0, 40),
      },
      qualification_proof: {
        label: "Angle Kualifikasi B2B",
        primaryText:
          `Dirancang khusus bagi pemilik bisnis dan brand yang mengutamakan kecepatan eksekusi serta kerapihan hasil pada ${product.name}.\n\n` +
          `Alur kerja terstruktur dari briefing, preview progres, hingga serah terima file siap pakai.${anchor}\n\n` +
          `Kirim pesan WhatsApp untuk cek slot pengerjaan dan kecocokan kebutuhan.`,
        headline: `Solusi ${shortName} Bisnis`.slice(0, 40),
      },
      contrarian_efficiency: {
        label: "Angle Hemat Biaya Tim",
        primaryText:
          `Daripada mengeluarkan biaya tetap bulanan besar untuk trial-and-error sendiri, serahkan pengerjaan ${product.name} ke spesialis AI.\n\n` +
          `Hasil lebih konsisten, waktu rilis lebih singkat, dan biaya jauh lebih terkontrol.${anchor}\n\n` +
          `Tanyakan detail paket dan contoh portofolio langsung lewat WhatsApp.`,
        headline: `Hemat Waktu dengan ${shortName}`.slice(0, 40),
      },
    };
    const v = variants[baseAngle];
    return {
      adName: `${shortName} - ${v.label}`.slice(0, 100),
      primaryText: v.primaryText,
      headline: v.headline.slice(0, 40),
      description: "Respon cepat via WhatsApp",
      cta: "WHATSAPP_MESSAGE",
    };
  }

  // Lini Digital (lynk.id -> sales, SHOP_NOW)
  const priceHook = priceText && (product.price ?? 0) <= 250_000 ? ` - akses lengkap hanya ${priceText}` : "";
  const variants: Record<CanonicalAngle, { primaryText: string; headline: string; label: string }> = {
    pain_agitation: {
      label: "Angle Pangkas Waktu",
      primaryText:
        `Berhenti membuang waktu berjam-jam menyusun semuanya dari nol ketika sistem siap pakai sudah tersedia.\n\n` +
        `${product.name} merangkum alur praktis, template teruji, dan panduan langkah demi langkah Bahasa Indonesia yang langsung bisa dipraktikkan hari ini${priceHook}.\n\n` +
        `Akses otomatis langsung terkirim instan begitu pembayaran selesai.`,
      headline: priceText ? fitHeadline(`Akses Instan ${shortName} ${priceText}`, `Akses Instan ${shortName}`) : `Akses Instan ${shortName}`.slice(0, 40),
    },
    outcome_mechanism: {
      label: "Angle Mekanisme Praktis",
      primaryText:
        `Pangkas proses kerja dari berjam-jam menjadi hitungan menit menggunakan sistem terstruktur di ${product.name}.\n\n` +
        `Cocok untuk pemula maupun praktisi tanpa perlu keahlian coding atau software mahal. Tinggal ikuti urutan panduannya dan terapkan langsung${priceHook}.\n\n` +
        `Klik tombol di bawah untuk mengunduh akses penuhnya sekarang.`,
      headline: `${shortName} Siap Pakai`.slice(0, 40),
    },
    direct_offer: {
      label: "Angle Direct Value",
      primaryText:
        `Paket lengkap ${product.name}: materi inti, template siap eksekusi, dan panduan praktis dalam satu akses sekali bayar${priceHook}.\n\n` +
        `Tanpa biaya langganan bulanan tambahan dan file langsung terbuka otomatis setelah checkout selesai.\n\n` +
        `Ambil aksesnya sekarang di halaman resmi produk.`,
      headline: priceText ? fitHeadline(`${shortName} - ${priceText}`, `Paket Lengkap ${shortName}`) : `Paket Lengkap ${shortName}`.slice(0, 40),
    },
    qualification_proof: {
      label: "Angle Skenario Nyata",
      primaryText:
        `Banyak kreator dan pelaku usaha kehabisan energi di tahap teknis sebelum sempat merilis karya atau produknya.\n\n` +
        `Lewat ${product.name}, seluruh kerangka kerja sudah disiapkan rapi sehingga fokus utama cukup pada eksekusi dan hasil akhir${priceHook}.\n\n` +
        `Pelajari isi lengkapnya dan dapatkan akses instan melalui tautan di bawah.`,
      headline: `Panduan & Sistem ${shortName}`.slice(0, 40),
    },
    contrarian_efficiency: {
      label: "Angle Anti Trial-Error",
      primaryText:
        `Coba-coba sendiri tanpa panduan sering menghabiskan kuota tool dan waktu berhari-hari tanpa hasil yang konsisten.\n\n` +
        `${product.name} memberikan formula yang sudah disaring rapi agar alur produksi langsung terarah sejak percobaan pertama${priceHook}.\n\n` +
        `Klik Beli Sekarang untuk menerima akses instan.`,
      headline: `Sistem Praktis ${shortName}`.slice(0, 40),
    },
  };
  const v = variants[baseAngle];
  return {
    adName: `${shortName} - ${v.label}`.slice(0, 100),
    primaryText: v.primaryText,
    headline: v.headline.slice(0, 40),
    description: priceText ? `Sekali bayar ${priceText} - Akses instan` : "Akses instan otomatis",
    cta: "SHOP_NOW",
  };
}

/* ------------------------------------------------------------------ 3. Rekonsiliasi Memori di Database */

export async function reconcileAccountMemories(account: Account, products: ProductUnitEcon[]): Promise<number> {
  const testing = await sql`
    SELECT id, product_id, campaign_id, angle, created_at
    FROM agent_memories
    WHERE account_id = ${account.id} AND outcome = 'testing' AND campaign_id IS NOT NULL
    LIMIT 50`;
  if (!testing.length) return 0;

  const campaignIds = [...new Set(testing.map((m) => String(m.campaign_id)))];
  const minDate = testing.reduce((min, m) => {
    const d = (m.created_at as Date).toISOString().slice(0, 10);
    return d < min ? d : min;
  }, "9999-12-31");

  const aggRows = await sql`
    SELECT campaign_id,
           COALESCE(sum(spend), 0)::bigint AS spend,
           COALESCE(sum(impressions), 0)::bigint AS impressions,
           COALESCE(sum(clicks), 0)::bigint AS clicks,
           COALESCE(sum(purchases), 0)::int AS purchases,
           COALESCE(sum(leads), 0)::int AS leads,
           COALESCE(sum(purchase_value), 0)::bigint AS value
    FROM campaign_daily
    WHERE account_id = ${account.id} AND campaign_id = ANY(${campaignIds}) AND date >= ${minDate}::date
    GROUP BY campaign_id`;

  const aggByCamp = new Map(aggRows.map((r) => [String(r.campaign_id), r]));
  const prodById = new Map(products.map((p) => [p.id, p]));
  let updated = 0;

  for (const m of testing) {
    const agg = aggByCamp.get(String(m.campaign_id));
    const ageDays = Math.max(0, Math.floor((Date.now() - (m.created_at as Date).getTime()) / 86_400_000));
    const spend = Number(agg?.spend ?? 0);
    const impressions = Number(agg?.impressions ?? 0);
    const clicks = Number(agg?.clicks ?? 0);
    const results = account.line === "jasa" ? Number(agg?.leads ?? 0) : Number(agg?.purchases ?? 0);
    const revenue = account.line === "jasa" ? 0 : Number(agg?.value ?? 0);
    const prod = m.product_id ? prodById.get(Number(m.product_id)) : undefined;

    const ev = evaluateExperimentOutcome(
      { spend, impressions, clicks, results, revenue, ageDays },
      { line: account.line, settings: account.settings, maxBreakEvenCpa: prod?.maxBreakEvenCpa },
    );
    const metrics = {
      spend,
      results,
      cpa: results > 0 ? Math.round(spend / results) : null,
      roas: spend > 0 && revenue > 0 ? Math.round((revenue / spend) * 100) / 100 : 0,
    };
    if (ev.outcome !== "testing") {
      await sql`
        UPDATE agent_memories
        SET outcome = ${ev.outcome}, metrics = ${sql.json(metrics as any)}, lesson = ${ev.lesson}, updated_at = now()
        WHERE id = ${Number(m.id)}`;
      updated++;
    } else if (spend > 0) {
      await sql`
        UPDATE agent_memories
        SET metrics = ${sql.json(metrics as any)}, updated_at = now()
        WHERE id = ${Number(m.id)}`;
    }
  }
  return updated;
}

/* ------------------------------------------------------------------ 4. Dossier Intelijen Bisnis & P&L Lengkap */

export interface CreativeCandidate {
  assetId: number | null;
  productId: number | null;
  name: string;
  kind: "image" | "video" | "post" | "existing_creative";
  imageHash?: string | null;
  imageUrl?: string | null;
  videoId?: string | null;
  thumbnailHash?: string | null;
  objectStoryId?: string | null;
  creativeId?: string | null;
  timesUsed: number;
}

export interface AccountDossier {
  account: Account;
  pl: AgentPlSnapshot;
  guardrailCtx: GuardrailContext;
  guardrails: GuardrailState;
  products: ProductUnitEcon[];
  campaigns7d: {
    id: string;
    name: string;
    status: string;
    dailyBudget: number | null;
    ageDays: number;
    spend7d: number;
    results7d: number;
    cpa7d: number | null;
    roas7d: number;
    ctrPct7d: number;
    spend3d: number;
    results3d: number;
    recCode: string;
  }[];
  liveAds14d: {
    id: string;
    name: string;
    campaignId: string | null;
    spend: number;
    results: number;
    costPerResult: number | null;
    ctrLink: number;
  }[];
  activeAdsets: { id: string; name: string; campaignId: string | null }[];
  metaInfra: {
    readyForLaunch: boolean;
    demoMode: boolean;
    pageId: string | null;
    instagramUserId: string | null;
    pixelId: string | null;
  };
  creativePool: CreativeCandidate[];
  memories: Pick<AgentMemory, "id" | "productId" | "productName" | "campaignId" | "angle" | "headline" | "outcome" | "lesson" | "metrics">[];
  funnelSignals: string[];
}

async function queryProductsWithEcon(cfg: Config): Promise<ProductUnitEcon[]> {
  const feeMap = new Map(cfg.lineSettings.map((l) => [l.line, l.feePct]));
  const taxByLine: Record<Line, number> = {
    digital: cfg.accounts.find((a) => a.line === "digital" && a.active)?.settings.adTaxPct ?? 3,
    jasa: cfg.accounts.find((a) => a.line === "jasa" && a.active)?.settings.adTaxPct ?? 3,
  };
  const rows = await sql`
    SELECT p.id, p.line, p.name, p.price, p.cogs, p.url,
           COALESCE(SUM(s.qty) FILTER (WHERE s.deleted_at IS NULL AND s.date >= (now() AT TIME ZONE 'Asia/Jakarta')::date - 30), 0)::int AS qty_30d,
           COALESCE(SUM(s.revenue) FILTER (WHERE s.deleted_at IS NULL AND s.date >= (now() AT TIME ZONE 'Asia/Jakarta')::date - 30), 0)::bigint AS rev_30d,
           (SELECT count(*)::int FROM product_assets pa WHERE pa.product_id = p.id AND pa.active = true) AS asset_count
    FROM products p
    LEFT JOIN sales s ON s.product_id = p.id
    WHERE p.active = true
    GROUP BY p.id
    ORDER BY rev_30d DESC, p.id ASC
    LIMIT 100`;
  return rows.map((r) => computeProductUnitEconomics({
    id: Number(r.id),
    line: r.line as Line,
    name: String(r.name),
    price: r.price != null ? Number(r.price) : null,
    cogs: Number(r.cogs ?? 0),
    url: (r.url as string | null) ?? null,
    sold30d: Number(r.qty_30d ?? 0),
    revenue30d: Number(r.rev_30d ?? 0),
    assetCount: Number(r.asset_count ?? 0),
    feePct: feeMap.get(r.line as Line) ?? 0,
    adTaxPct: taxByLine[r.line as Line] ?? 3,
  }));
}

async function buildAccountDossier(account: Account, cfg: Config, allProducts: ProductUnitEcon[]): Promise<AccountDossier> {
  const scope = resolveScope(account.id, cfg);
  const rToday = resolveRange(undefined, undefined, "today");
  const r7 = resolveRange(undefined, undefined, "7d");
  const r30 = resolveRange(undefined, undefined, "30d");

  const [sumToday, sum7, sum30, camps7, diag7, campMetaRows, recentActRows, assetRows, memRows, launchStatsRow] = await Promise.all([
    Q.summaryFor(scope, rToday, cfg),
    Q.summaryFor(scope, r7, cfg),
    Q.summaryFor(scope, r30, cfg),
    Q.campaigns(scope, r7),
    diagnose(scope, r7, null).catch(() => null),
    sql`
      SELECT c.id, c.daily_budget, c.created_time,
             COALESCE((
               SELECT sum(d.spend) FROM campaign_daily d
               WHERE d.campaign_id = c.id AND d.date >= (now() AT TIME ZONE 'Asia/Jakarta')::date - 2
             ), 0)::bigint AS spend_3d,
             COALESCE((
               SELECT sum(CASE WHEN ${account.line} = 'jasa' THEN d.leads ELSE d.purchases END) FROM campaign_daily d
               WHERE d.campaign_id = c.id AND d.date >= (now() AT TIME ZONE 'Asia/Jakarta')::date - 2
             ), 0)::int AS res_3d
      FROM campaigns c
      WHERE c.account_id = ${account.id}`,
    sql`
      SELECT campaign_id, max(created_at) AS last_at
      FROM bot_actions
      WHERE account_id = ${account.id} AND campaign_id IS NOT NULL AND status IN ('executed','pending')
        AND created_at > now() - interval '72 hours'
      GROUP BY campaign_id`,
    sql`
      SELECT pa.id, pa.product_id, pa.name, pa.kind, pa.image_hash, pa.image_url, pa.video_id, pa.thumbnail_hash, pa.object_story_id, pa.times_used
      FROM product_assets pa
      JOIN products p ON p.id = pa.product_id
      WHERE pa.active = true AND p.active = true AND p.line = ${account.line}
        AND (pa.account_id IS NULL OR pa.account_id = ${account.id})
      ORDER BY pa.times_used ASC, pa.id DESC
      LIMIT 30`,
    sql`
      SELECT m.id, m.product_id, p.name AS product_name, m.campaign_id, m.angle, m.headline, m.outcome, m.lesson, m.metrics
      FROM agent_memories m
      LEFT JOIN products p ON p.id = m.product_id
      WHERE m.account_id = ${account.id}
      ORDER BY m.updated_at DESC, m.id DESC
      LIMIT 25`,
    sql`
      SELECT
        count(*) FILTER (WHERE action IN ('launch','add_ads') AND source = 'autopilot' AND status IN ('executed','pending') AND created_at > now() - interval '24 hours')::int AS launches_today,
        count(*) FILTER (WHERE action IN ('launch','add_ads') AND status = 'failed' AND created_at > now() - interval '7 days')::int AS failed_7d
      FROM bot_actions
      WHERE account_id = ${account.id}`,
  ]);

  const activeDailyBudget = camps7.rows
    .filter((c) => c.status === "ACTIVE")
    .reduce((s, c) => s + Number(c.dailyBudget ?? 0), 0);

  const pl: AgentPlSnapshot = {
    todayNet: Math.round(sumToday.kpis.net),
    todaySpend: Math.round(sumToday.kpis.spend),
    todayRevenue: Math.round(sumToday.kpis.revenue),
    todayRoas: Math.round(sumToday.kpis.roas * 100) / 100,
    net7d: Math.round(sum7.kpis.net),
    spend7d: Math.round(sum7.kpis.spend),
    revenue7d: Math.round(sum7.kpis.revenue),
    roas7d: Math.round(sum7.kpis.roas * 100) / 100,
    beRoas7d: Math.round(sum7.kpis.beRoas * 100) / 100,
    cpa7d: Math.round(sum7.kpis.cpa),
    maxCpaBE7d: Math.round(sum7.kpis.maxCpaBE),
    cpl7d: Math.round(sum7.kpis.cpl),
    closeRate7d: Math.round(sum7.kpis.closeRate * 1000) / 10,
    net30d: Math.round(sum30.kpis.net),
    roas30d: Math.round(sum30.kpis.roas * 100) / 100,
    activeDailyBudget,
  };

  const metaByCamp = new Map(campMetaRows.map((r) => [String(r.id), r]));
  const campaignAgeDays = new Map<string, number>();
  for (const r of campMetaRows) {
    if (r.created_time) {
      const age = Math.max(0, Math.floor((Date.now() - new Date(r.created_time).getTime()) / 86_400_000));
      campaignAgeDays.set(String(r.id), age);
    }
  }
  const lastActionMsByCampaign = new Map<string, number>();
  for (const r of recentActRows) {
    if (r.campaign_id && r.last_at) lastActionMsByCampaign.set(String(r.campaign_id), new Date(r.last_at).getTime());
  }

  const guardrailCtx: GuardrailContext = {
    settings: account.settings,
    pl,
    hourWib: hourNow(),
    launchesToday: Number(launchStatsRow[0]?.launches_today ?? 0),
    failedLaunches7d: Number(launchStatsRow[0]?.failed_7d ?? 0),
    lastActionMsByCampaign,
    campaignAgeDays,
  };
  const guardrails = evaluateGuardrails(guardrailCtx);

  const creativePool: CreativeCandidate[] = assetRows.map((a) => ({
    assetId: Number(a.id),
    productId: Number(a.product_id),
    name: String(a.name),
    kind: a.kind as "image" | "video" | "post",
    imageHash: a.image_hash,
    imageUrl: a.image_url,
    videoId: a.video_id,
    thumbnailHash: a.thumbnail_hash,
    objectStoryId: a.object_story_id,
    timesUsed: Number(a.times_used ?? 0),
  }));

  let liveAds14d: AccountDossier["liveAds14d"] = [];
  let activeAdsets: AccountDossier["activeAdsets"] = [];
  const demoMode = !metaConfigured();
  const metaInfra = {
    readyForLaunch: false,
    demoMode,
    pageId: demoMode ? "10000000001" : null as string | null,
    instagramUserId: null as string | null,
    pixelId: demoMode && account.line === "digital" ? "20000000001" : null as string | null,
  };

  if (metaMode() === "mcp") {
    const [adBr, lctx] = await Promise.all([
      adBreakdown({ id: account.id, line: account.line }, null, "last_14d", 20).catch(() => null),
      launchContext(account.id).catch(() => null),
    ]);
    if (adBr && "ads" in adBr && Array.isArray(adBr.ads)) {
      liveAds14d = adBr.ads
        .filter((a) => a.status === "ACTIVE")
        .map((a) => ({
          id: a.id,
          name: a.name,
          campaignId: a.campaignId,
          spend: a.spend,
          results: a.results,
          costPerResult: a.costPerResult,
          ctrLink: a.ctrLink,
        }));
    }
    if (lctx && !("error" in lctx)) {
      const pages = Array.isArray(lctx.pages) ? lctx.pages : [];
      const igs = Array.isArray(lctx.instagramAccounts) ? lctx.instagramAccounts : [];
      const pixels = Array.isArray(lctx.pixels) ? lctx.pixels : [];
      metaInfra.pageId = pages[0]?.id ? String(pages[0].id) : pages[0]?.page_id ? String(pages[0].page_id) : null;
      metaInfra.instagramUserId = igs[0]?.id ? String(igs[0].id) : igs[0]?.instagram_user_id ? String(igs[0].instagram_user_id) : null;
      metaInfra.pixelId = pixels[0]?.id ? String(pixels[0].id) : null;
      activeAdsets = (lctx.activeAdsets ?? []).map((s) => ({ id: s.id, name: s.name, campaignId: s.campaignId }));

      const existingCreatives = Array.isArray(lctx.existingCreatives) ? lctx.existingCreatives : [];
      for (const cr of existingCreatives.slice(0, 10)) {
        if (cr?.image_hash || cr?.video_id || cr?.object_story_id || cr?.id) {
          creativePool.push({
            assetId: null,
            productId: null,
            name: String(cr.name ?? `Meta Creative ${cr.id}`),
            kind: cr.object_story_id ? "post" : cr.video_id ? "video" : cr.image_hash ? "image" : "existing_creative",
            imageHash: cr.image_hash ? String(cr.image_hash) : null,
            videoId: cr.video_id ? String(cr.video_id) : null,
            objectStoryId: cr.object_story_id ? String(cr.object_story_id) : null,
            creativeId: cr.id ? String(cr.id) : null,
            timesUsed: 1,
          });
        }
      }
    }
  } else if (demoMode && creativePool.length === 0) {
    creativePool.push({
      assetId: null,
      productId: null,
      name: "Visual Default Simulasi",
      kind: "image",
      imageHash: "demo_visual_hash_01",
      timesUsed: 0,
    });
  }

  metaInfra.readyForLaunch = Boolean(
    metaInfra.pageId && (account.line === "jasa" || metaInfra.pixelId) && creativePool.length > 0 && (metaMode() === "mcp" || demoMode),
  );

  const lineProducts = allProducts.filter((p) => p.line === account.line);
  const campaigns7d = camps7.rows.map((c) => {
    const m = metaByCamp.get(c.id);
    const results7d = account.line === "jasa" ? c.leads : c.purchases;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      dailyBudget: c.dailyBudget,
      ageDays: campaignAgeDays.get(c.id) ?? 7,
      spend7d: c.spend,
      results7d,
      cpa7d: account.line === "jasa" ? (c.cpl && Math.round(c.cpl)) : (c.cpa && Math.round(c.cpa)),
      roas7d: Math.round(c.roas * 100) / 100,
      ctrPct7d: Math.round(c.ctr * 10000) / 100,
      spend3d: Number(m?.spend_3d ?? 0),
      results3d: Number(m?.res_3d ?? 0),
      recCode: c.rec.code,
    };
  });

  return {
    account,
    pl,
    guardrailCtx,
    guardrails,
    products: lineProducts,
    campaigns7d,
    liveAds14d,
    activeAdsets,
    metaInfra,
    creativePool,
    memories: memRows.map((m) => ({
      id: Number(m.id),
      productId: m.product_id != null ? Number(m.product_id) : null,
      productName: m.product_name ?? null,
      campaignId: m.campaign_id ?? null,
      angle: String(m.angle),
      headline: m.headline ?? null,
      outcome: m.outcome as AgentMemory["outcome"],
      lesson: m.lesson ?? null,
      metrics: (m.metrics as AgentMemory["metrics"]) ?? {},
    })),
    funnelSignals: diag7?.signals ?? [],
  };
}

/* ------------------------------------------------------------------ 5. Perencana Strategi (AI + Kuantitatif Fallback) */

const plannedCopySchema = z.object({
  angle: z.string().trim().min(2).max(60),
  adName: z.string().trim().min(3).max(110),
  primaryText: z.string().trim().min(25).max(1800),
  headline: z.string().trim().min(3).max(60),
  description: z.string().trim().max(120).optional(),
  cta: z.enum(LAUNCH_CTAS).optional(),
  assetIndex: z.number().int().min(0).optional(),
});

const plannedDecisionSchema = z.object({
  kind: z.enum(["pause_campaign", "pause_ad", "scale_campaign", "inject_ads", "launch_campaign", "hold"]),
  campaignId: z.string().optional().nullable(),
  adId: z.string().optional().nullable(),
  adName: z.string().optional().nullable(),
  productId: z.number().int().optional().nullable(),
  scalePct: z.number().min(5).max(50).optional(),
  dailyBudget: z.number().int().positive().optional(),
  campaignName: z.string().trim().max(110).optional(),
  ads: z.array(plannedCopySchema).min(1).max(3).optional(),
  rationale: z.string().trim().min(5).max(600),
});

export const aiPlanOutputSchema = z.object({
  diagnosis: z.string().trim().min(10).max(2000),
  decisions: z.array(plannedDecisionSchema).min(1).max(8),
});
export type PlannedOutput = z.infer<typeof aiPlanOutputSchema>;
export type PlannedDecision = z.infer<typeof plannedDecisionSchema>;

/** Strategi kuantitatif deterministik: bekerja akurat 100% bahkan tanpa koneksi LLM, sekaligus menjadi jaring pengaman. */
export function buildDeterministicProfitPlan(d: AccountDossier): PlannedOutput {
  const acc = d.account;
  const st = acc.settings;
  const isJasa = acc.line === "jasa";
  const targetCost = (isJasa ? st.maxCpl : st.maxCpa) ?? Math.round(st.killAfterSpend / 2);
  const decisions: PlannedDecision[] = [];

  const activeCamps = d.campaigns7d.filter((c) => c.status === "ACTIVE");
  const pausedCampaignIds = new Set<string>();

  // 1) Bedah level iklan (CBO): matikan iklan yang membakar spend >= batas tanpa hasil sementara kampanyenya masih layak dipertahankan.
  for (const ad of d.liveAds14d) {
    if (!ad.campaignId) continue;
    const parentCamp = activeCamps.find((c) => c.id === ad.campaignId);
    if (!parentCamp || parentCamp.recCode === "kill") continue;
    const adBleeding = ad.spend >= Math.max(targetCost * 1.6, st.killAfterSpend * 0.75)
      && (ad.results === 0 || (ad.costPerResult != null && ad.costPerResult > targetCost * 1.5));
    if (adBleeding) {
      decisions.push({
        kind: "pause_ad",
        campaignId: ad.campaignId,
        adId: ad.id,
        adName: ad.name,
        rationale: `Iklan menghabiskan ${rpk(ad.spend)} dengan ${ad.results} hasil (${ad.costPerResult ? `CPA ${rpk(ad.costPerResult)}` : "0 konversi"}), menguras budget CBO kampanye ${parentCamp.name}.`,
      });
    }
  }

  // 2) Matikan kampanye yang boncos melewati killAfterSpend & di atas batas CPA/CPL akun.
  for (const c of activeCamps) {
    if (c.recCode === "kill" && (c.ageDays >= 3 || c.spend7d >= st.killAfterSpend)) {
      pausedCampaignIds.add(c.id);
      decisions.push({
        kind: "pause_campaign",
        campaignId: c.id,
        rationale: `Spend 7 hari ${rpk(c.spend7d)} melewati batas kill ${rpk(st.killAfterSpend)} dengan ${c.results7d} hasil (${c.cpa7d ? `${isJasa ? "CPL" : "CPA"} ${rpk(c.cpa7d)} > batas ${rpk(targetCost)}` : "tanpa konversi"}). Hentikan kebocoran rugi.`,
      });
    }
  }

  // 3) Dorong ke Laba (Push-to-Profit): jika ada kampanye dimatikan karena rugi, kampanye butuh refresh kreatif,
  // atau belum ada kampanye aktif sama sekali sementara ada produk bermargin sehat & infrastruktur siap -> luncurkan/suntik iklan baru!
  // Diprioritaskan sebelum scale_campaign agar penggantian iklan merugi tidak pernah terpotong batas maksimal keputusan per siklus.
  const remainingActive = activeCamps.filter((c) => !pausedCampaignIds.has(c.id));
  const creativeFatigueCamp = remainingActive.find((c) => c.recCode === "creative");
  const needsProfitPush = pausedCampaignIds.size > 0 || remainingActive.length === 0 || Boolean(creativeFatigueCamp) || d.pl.net7d < 0;

  if (needsProfitPush && d.metaInfra.readyForLaunch && !d.guardrails.stopLossTriggered && !d.guardrails.rejectionCircuitOpen && st.autoLaunchEnabled && !d.guardrails.launchQuotaFull) {
    const viableProducts = d.products
      .filter((p) => (isJasa || (p.url && p.url.startsWith("http"))) && (p.maxBreakEvenCpa == null || p.maxBreakEvenCpa > 15_000))
      .sort((a, b) => (b.revenue30d - a.revenue30d) || ((b.profitBeforeAds ?? 0) - (a.profitBeforeAds ?? 0)));
    const targetProduct = viableProducts[0];

    if (targetProduct) {
      const nextAngles = selectNextAngles(d.memories, targetProduct.id, 2);
      const prodAssets = d.creativePool
        .map((c, idx) => ({ c, idx }))
        .filter(({ c }) => c.productId === targetProduct.id || c.productId === null);

      if (prodAssets.length > 0) {
        const ads = nextAngles.map((angle, i) => {
          const copy = synthesizeCompliantCopy(targetProduct, angle);
          const chosenAsset = prodAssets[i % prodAssets.length];
          return {
            angle,
            adName: copy.adName,
            primaryText: copy.primaryText,
            headline: copy.headline,
            description: copy.description,
            cta: copy.cta,
            assetIndex: chosenAsset.idx,
          };
        });

        // Opsi Injeksi: jika ada kampanye fatigue yang sudah memiliki ad set tunggal aktif, suntikkan ke dalamnya; jika tidak, luncurkan kampanye CBO baru.
        const matchingAdsets = creativeFatigueCamp
          ? d.activeAdsets.filter((s) => s.campaignId === creativeFatigueCamp.id)
          : [];

        if (creativeFatigueCamp && matchingAdsets.length === 1 && pausedCampaignIds.size === 0) {
          decisions.push({
            kind: "inject_ads",
            campaignId: creativeFatigueCamp.id,
            productId: targetProduct.id,
            ads,
            rationale: `Menyuntikkan ${ads.length} angle baru (${nextAngles.join(", ")}) untuk ${targetProduct.name} ke kampanye ${creativeFatigueCamp.name} guna memulihkan CTR/CVR di bawah batas CPA impas ${targetProduct.maxBreakEvenCpa ? rpk(targetProduct.maxBreakEvenCpa) : rpk(targetCost)}.`,
          });
        } else {
          const econCpa = targetProduct.maxBreakEvenCpa
            ? Math.min(targetCost, Math.floor(targetProduct.maxBreakEvenCpa * 0.75))
            : targetCost;
          const idealBudget = Math.max(50_000, Math.round((econCpa * 2) / 5_000) * 5_000);
          const cappedBudget = st.maxDailyBudget ? Math.min(idealBudget, st.maxDailyBudget) : idealBudget;
          const dateTag = new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "short", timeZone: "Asia/Jakarta" });
          decisions.push({
            kind: "launch_campaign",
            productId: targetProduct.id,
            dailyBudget: cappedBudget,
            campaignName: `Autopilot ${isJasa ? "Leads" : "Sales"} - ${targetProduct.name.slice(0, 32)} - ${dateTag}`,
            ads,
            rationale: `Meluncurkan 1 kampanye CBO Advantage+ dengan ${ads.length} variasi angle baru (${nextAngles.join(", ")}) untuk produk ${targetProduct.name} (margin ${targetProduct.profitBeforeAds ? rpk(targetProduct.profitBeforeAds) : "positif"}, CPA impas ${targetProduct.maxBreakEvenCpa ? rpk(targetProduct.maxBreakEvenCpa) : rpk(targetCost)}) menggantikan iklan yang merugi.`,
          });
        }
      }
    }
  }

  // 4) Scale vertikal maksimal 3 kampanye paling profitabel per siklus (ROAS >= 1.3x target atau CPA <= 75% batas dengan >= 3 konversi).
  const winnersToScale = remainingActive
    .filter((c) => {
      const strongWinner = c.recCode === "scale"
        || (c.results7d >= 3 && c.cpa7d != null && c.cpa7d <= targetCost * 0.75 && (isJasa || c.roas7d >= st.targetRoas));
      return strongWinner && Boolean(c.dailyBudget);
    })
    .sort((a, b) => (b.roas7d - a.roas7d) || (b.results7d - a.results7d))
    .slice(0, 3);

  for (const c of winnersToScale) {
    decisions.push({
      kind: "scale_campaign",
      campaignId: c.id,
      scalePct: st.scaleStepPct,
      rationale: `Kampanye mencetak ${c.results7d} hasil (${isJasa ? "CPL" : "CPA"} ${rpk(c.cpa7d ?? 0)}, ROAS ${dec(c.roas7d)}x vs target ${dec(st.targetRoas)}x). Naikkan budget +${st.scaleStepPct}% untuk memperbesar laba bersih.`,
    });
  }

  if (!decisions.length) {
    decisions.push({
      kind: "hold",
      rationale: activeCamps.length
        ? "Seluruh kampanye aktif berada dalam koridor rasio biaya/hasil yang sehat atau masih mengumpulkan sampel konversi awal. Pertahankan stabilitas algoritma."
        : d.metaInfra.readyForLaunch
          ? "Menunggu sinyal data atau produk siap tayang dengan URL/aset valid."
          : "Belum ada kampanye aktif dan akun membutuhkan koneksi MCP Meta + aset kreatif di Bank Aset untuk meluncurkan iklan baru.",
    });
  }

  const netStatus = d.pl.net7d >= 0 ? `mencetak laba bersih 7 hari ${rp(d.pl.net7d)}` : `masih mengalami defisit laba bersih 7 hari ${rp(d.pl.net7d)}`;
  const diagnosis =
    `Akun ${acc.name} (${LINES[acc.line].label}) ${netStatus} dari omzet riil ${rp(d.pl.revenue7d)} dan spend iklan ${rp(d.pl.spend7d)} ` +
    `(ROAS riil ${dec(d.pl.roas7d)}x vs titik impas ${dec(d.pl.beRoas7d)}x; laba hari ini ${rp(d.pl.todayNet)}). ` +
    (pausedCampaignIds.size > 0
      ? `${pausedCampaignIds.size} kampanye boncos dihentikan dan digantikan eksperimen kreatif ber-angle baru berdasarkan perhitungan batas CPA impas produk.`
      : d.funnelSignals[0] ?? `Evaluasi mencakup ${activeCamps.length} kampanye aktif dan ${d.memories.length} memori eksperimen angle.`);

  return { diagnosis, decisions: decisions.slice(0, 8) };
}

function autopilotSystemPrompt(): string {
  return `Kamu adalah Chief Autonomous Profit & Meta Ads Agent untuk bisnis Produk Digital AI (lynk.id) dan Jasa AI (WhatsApp).
Misi tunggalmu: menghasilkan LABA BERSIH RIIL positif (Laba Bersih = Omzet Riil - Fee Platform - HPP - Spend Iklan - PPN Iklan - Biaya Tetap Prorata - Biaya Operasional Lain) secara disiplin, terukur, dan aman.

ATURAN KERJA & GROUNDING (MUTLAK):
1. DILARANG memanggil tool apa pun; seluruh data P&L, unit economics produk, kampanye 7h/3h, iklan individual 14h, aset kreatif, dan memori angle sudah tersedia lengkap di JSON input.
2. DILARANG mengarang ID: hanya gunakan campaignId, adId, productId, dan assetIndex yang benar-benar ada di JSON input.
3. DILARANG menggunakan emoji di diagnosis maupun di seluruh teks iklan (primaryText, headline, description, adName).
4. KEPATUHAN KEBIJAKAN META ADS:
   - Dilarang menyebut kondisi pribadi/keuangan penonton secara langsung ("Kamu yang lagi boncos/miskin/nganggur/stres"). Gunakan kalimat objektif fokus masalah/proses.
   - Dilarang menjanjikan hasil/keuntungan pasti ("dijamin cuan", "auto kaya", "100% pasti untung").
   - Headline WAJIB <= 40 karakter agar utuh di Feed & Reels HP.
   - 125 karakter pertama primaryText wajib menjadi thumb-stopping hook spesifik masalah/hasil terukur.
5. DISIPLIN PROFIT-LOOP:
   - Jika ada iklan individual di dalam kampanye sehat yang membakar spend besar dengan 0 hasil / CPA jauh di atas batas -> gunakan "pause_ad".
   - Jika ada kampanye aktif dengan spend7d >= killAfterSpend dan CPA/CPL di atas batas impas/aturan (dan ageDays >= 3 atau spend >= killAfterSpend) -> gunakan "pause_campaign".
   - Jika akun masih rugi (net7d < 0), atau baru mematikan kampanye boncos, atau ada kampanye fatigue, DAN metaInfra.readyForLaunch == true serta tidak diblokir guardrail -> WAJIB susun "launch_campaign" (atau "inject_ads" bila kampanye tujuan punya 1 activeAdset) untuk produk bermargin terbaik memakai 2 variasi angle BARU yang TIDAK berstatus "losing" atau "testing" di memories!
   - Jika kampanye mencetak ROAS jauh di atas targetRoas (>= 1.3x target) atau CPA <= 75% batas dengan >= 3 hasil -> gunakan "scale_campaign" sebesar scaleStepPct%.
   - Jika semua kampanye masih fase belajar (< 3 hari dan spend < killAfterSpend) atau sudah optimal -> gunakan "hold".

FORMAT OUTPUT (WAJIB HANYA RAW JSON VALID TANPA MARKDOWN FENCE):
{
  "diagnosis": "Ringkasan tajam 2-4 kalimat berisi angka Laba Bersih, ROAS riil vs impas, akar masalah funnel, dan alasan strategi.",
  "decisions": [
    {
      "kind": "pause_campaign" | "pause_ad" | "scale_campaign" | "inject_ads" | "launch_campaign" | "hold",
      "campaignId": "string (wajib untuk pause_campaign, pause_ad, scale_campaign, inject_ads)",
      "adId": "string (wajib untuk pause_ad)",
      "adName": "string (opsional untuk pause_ad)",
      "productId": 1,
      "scalePct": 20,
      "dailyBudget": 100000,
      "campaignName": "Autopilot Sales - Nama Produk - Tanggal",
      "ads": [
        {
          "angle": "pain_agitation | outcome_mechanism | direct_offer | qualification_proof | contrarian_efficiency",
          "adName": "Nama Variasi - Angle",
          "primaryText": "Paragraf Direct-Response kuat tanpa emoji...",
          "headline": "Maksimal 40 Karakter",
          "description": "Subjudul singkat",
          "cta": "SHOP_NOW | WHATSAPP_MESSAGE | LEARN_MORE | GET_OFFER",
          "assetIndex": 0
        }
      ],
      "rationale": "Alasan kuantitatif singkat berbasis CPA/ROAS/margin."
    }
  ]
}`;
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Respons AI tidak memuat objek JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}

let anthropicClient: Anthropic | null = null;
const getAnthropic = () => (anthropicClient ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }));

async function planWithAi(d: AccountDossier): Promise<{ plan: PlannedOutput; brain: "ai" | "deterministic"; inputTokens: number; outputTokens: number }> {
  const mode = aiMode();
  if (mode === "none" || !aiConfigured()) {
    return { plan: buildDeterministicProfitPlan(d), brain: "deterministic", inputTokens: 0, outputTokens: 0 };
  }

  const promptPayload = {
    account: {
      id: d.account.id,
      name: d.account.name,
      line: d.account.line,
      botMode: d.account.botMode,
      settings: d.account.settings,
    },
    plSnapshot: d.pl,
    guardrails: d.guardrails,
    funnelSignals: d.funnelSignals,
    productsUnitEconomics: d.products,
    campaigns7d: d.campaigns7d,
    liveAds14d: d.liveAds14d,
    activeAdsets: d.activeAdsets,
    metaInfra: d.metaInfra,
    creativePool: d.creativePool.map((c, index) => ({
      assetIndex: index,
      productId: c.productId,
      name: c.name,
      kind: c.kind,
      timesUsed: c.timesUsed,
    })),
    experimentMemories: d.memories,
    suggestedUntestedAnglesByProduct: d.products.slice(0, 5).map((p) => ({
      productId: p.id,
      productName: p.name,
      recommendedAngles: selectNextAngles(d.memories, p.id, 3),
    })),
  };

  const userPrompt = `Evaluasi dossier bisnis & iklan berikut dan keluarkan JSON keputusan Autopilot Profit Engine:\n${JSON.stringify(promptPayload)}`;

  try {
    if (mode === "api") {
      const msg = await getAnthropic().messages.create({
        model: env.CLAUDE_MODEL,
        max_tokens: 2600,
        system: autopilotSystemPrompt(),
        messages: [{ role: "user", content: userPrompt }],
      });
      const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
      const parsed = aiPlanOutputSchema.parse(extractJsonObject(text));
      return {
        plan: parsed,
        brain: "ai",
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
      };
    }

    // Mode "bridge" (Claude Code di VPS host via deploy/claude-bridge.mjs)
    const today = resolveRange().today;
    const token = openChatSession({
      user: { id: 0, email: "autopilot@internal", name: "Autopilot", role: "admin" },
      ctx: { acc: d.account.id, from: today, to: today },
      emit: () => {},
    });
    let text = "";
    let usage = { input: 0, output: 0 };
    try {
      const res = await fetch(new URL("/v1/chat", env.CLAUDE_BRIDGE_URL), {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CLAUDE_BRIDGE_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: env.CLAUDE_MODEL,
          system: autopilotSystemPrompt(),
          prompt: userPrompt,
          mcpUrl: env.CLAUDE_MCP_URL,
          mcpToken: token,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok || !res.body) throw new Error(`Bridge HTTP ${res.status}`);
      const reader = res.body.getReader(), td = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += td.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const m = JSON.parse(line) as { t: string; v?: string; usage?: { input: number; output: number } };
          if (m.t === "text" && m.v) text += m.v;
          else if (m.t === "done" && m.usage) usage = { input: m.usage.input, output: m.usage.output };
          else if (m.t === "error") throw new Error(m.v || "Bridge error");
        }
      }
    } finally {
      closeChatSession(token);
    }
    const parsed = aiPlanOutputSchema.parse(extractJsonObject(text));
    return { plan: parsed, brain: "ai", inputTokens: usage.input, outputTokens: usage.output };
  } catch (e) {
    log.warn("perencanaan AI autopilot gagal, beralih ke fallback kuantitatif", { account: d.account.id, error: errMsg(e) });
    return { plan: buildDeterministicProfitPlan(d), brain: "deterministic", inputTokens: 0, outputTokens: 0 };
  }
}

/* ------------------------------------------------------------------ 6. Eksekutor Keputusan & Pencatatan Memori */

function stripEmojis(s: string): string {
  return s.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").replace(/\s{2,}/g, " ").trim();
}

function clampHeadline(h: string): string {
  const clean = stripEmojis(h);
  if (clean.length <= 40) return clean;
  const cut = clean.slice(0, 40);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace >= 22 ? cut.slice(0, lastSpace) : cut).trim();
}

function buildAdItemsFromDecision(
  decAds: NonNullable<PlannedDecision["ads"]>,
  d: AccountDossier,
  product: ProductUnitEcon | undefined,
): { items: AdItem[]; usedAssetIds: number[]; anglesMeta: { angle: string; headline: string; hook: string }[] } {
  const objective = d.account.line === "jasa" ? "leads_whatsapp" : "sales";
  const usedAssetIds: number[] = [];
  const anglesMeta: { angle: string; headline: string; hook: string }[] = [];
  const items: AdItem[] = [];

  const poolForProduct = d.creativePool.filter((c) => !product || c.productId === product.id || c.productId == null);
  const fallbackPool = poolForProduct.length ? poolForProduct : d.creativePool;
  if (!fallbackPool.length) return { items: [], usedAssetIds: [], anglesMeta: [] };

  for (let i = 0; i < decAds.length; i++) {
    const raw = decAds[i];
    const cand = (raw.assetIndex != null && d.creativePool[raw.assetIndex]) || fallbackPool[i % fallbackPool.length];
    if (cand.assetId != null && !usedAssetIds.includes(cand.assetId)) usedAssetIds.push(cand.assetId);

    const headline = clampHeadline(raw.headline);
    const primaryText = raw.primaryText.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").trim();
    const defaultCta = objective === "leads_whatsapp" ? "WHATSAPP_MESSAGE" : "SHOP_NOW";
    const cta = objective === "leads_whatsapp"
      ? "WHATSAPP_MESSAGE"
      : raw.cta && raw.cta !== "WHATSAPP_MESSAGE" ? raw.cta : defaultCta;

    let creative: CreativeSpec;
    if (cand.kind === "post" && cand.objectStoryId) {
      creative = { type: "post", objectStoryId: cand.objectStoryId };
    } else if (cand.kind === "existing_creative" && cand.creativeId && !cand.imageHash && !cand.videoId) {
      creative = { type: "existing", creativeId: cand.creativeId };
    } else if (cand.videoId) {
      creative = {
        type: "new",
        videoId: cand.videoId,
        ...(cand.thumbnailHash ? { imageHash: cand.thumbnailHash } : {}),
        primaryText,
        headline,
        description: raw.description ? stripEmojis(raw.description).slice(0, 90) : undefined,
        cta,
      };
    } else {
      creative = {
        type: "new",
        ...(cand.imageHash ? { imageHash: cand.imageHash } : { imageUrl: cand.imageUrl ?? undefined }),
        primaryText,
        headline,
        description: raw.description ? stripEmojis(raw.description).slice(0, 90) : undefined,
        cta,
      };
    }

    items.push({
      adName: stripEmojis(raw.adName).slice(0, 100) || `Variasi ${i + 1}`,
      creative,
      ...(objective !== "leads_whatsapp" && product?.url ? { linkUrl: product.url } : {}),
    });
    anglesMeta.push({
      angle: raw.angle,
      headline,
      hook: primaryText.slice(0, 140),
    });
  }
  return { items, usedAssetIds, anglesMeta };
}

async function executeAccountCycle(
  account: Account,
  trigger: "sync" | "manual" | "chat",
  cfg: Config,
  allProducts: ProductUnitEcon[],
  userId: number | null,
): Promise<AgentRun> {
  const effectiveMode = account.botMode === "off" ? "suggest" : account.botMode;
  const [runRow] = await sql`
    INSERT INTO agent_runs (account_id, trigger, mode, status)
    VALUES (${account.id}, ${trigger}, ${effectiveMode}::bot_mode, 'running')
    RETURNING id, started_at`;
  const runId = Number(runRow.id);

  try {
    await reconcileAccountMemories(account, allProducts);
    const dossier = await buildAccountDossier(account, cfg, allProducts);
    const planned = await planWithAi(dossier);

    const logs: AgentDecisionLog[] = [];
    const autoExec = effectiveMode === "auto";
    let mutableGuardrailCtx: GuardrailContext = { ...dossier.guardrailCtx };
    let blockedByGuardrail = false;

    for (const decItem of planned.plan.decisions) {
      if (decItem.kind === "hold") {
        logs.push({
          kind: "hold",
          targetName: account.name,
          rationale: stripEmojis(decItem.rationale),
          status: "skipped",
        });
        continue;
      }

      const camp = decItem.campaignId ? dossier.campaigns7d.find((c) => c.id === decItem.campaignId) : undefined;
      const gState = evaluateGuardrails(mutableGuardrailCtx);
      const gCheck = checkDecisionGuardrail(
        {
          kind: decItem.kind,
          campaignId: decItem.campaignId,
          dailyBudget: decItem.dailyBudget,
          currentDailyBudget: camp?.dailyBudget,
          scalePct: decItem.scalePct,
          spend: camp?.spend7d,
        },
        mutableGuardrailCtx,
        gState,
      );

      const prod = decItem.productId != null
        ? dossier.products.find((p) => p.id === decItem.productId)
        : dossier.products[0];

      if (!gCheck.ok) {
        blockedByGuardrail = true;
        logs.push({
          kind: decItem.kind,
          targetName: camp?.name ?? decItem.adName ?? decItem.campaignName ?? prod?.name ?? account.name,
          campaignId: decItem.campaignId ?? null,
          adId: decItem.adId ?? null,
          productName: prod?.name ?? null,
          rationale: stripEmojis(decItem.rationale),
          status: "blocked_guardrail",
          detail: gCheck.reason,
        });
        continue;
      }

      try {
        if (decItem.kind === "pause_campaign" || decItem.kind === "scale_campaign") {
          if (!camp) {
            logs.push({ kind: decItem.kind, targetName: String(decItem.campaignId ?? "Kampanye"), rationale: decItem.rationale, status: "skipped", detail: "ID kampanye tidak ditemukan di akun ini." });
            continue;
          }
          const actType = decItem.kind === "pause_campaign" ? "pause" : "scale";
          const created = await createCampaignAction({
            campaignId: camp.id,
            action: actType,
            pct: decItem.scalePct,
            source: "autopilot",
            userId,
            reason: stripEmojis(decItem.rationale),
          });
          const finalAct = autoExec ? await confirmAction(created.id) : created;
          mutableGuardrailCtx.lastActionMsByCampaign.set(camp.id, Date.now());
          if (actType === "scale" && gCheck.adjustedBudget && camp.dailyBudget) {
            mutableGuardrailCtx = {
              ...mutableGuardrailCtx,
              pl: { ...mutableGuardrailCtx.pl, activeDailyBudget: mutableGuardrailCtx.pl.activeDailyBudget + (gCheck.adjustedBudget - camp.dailyBudget) },
            };
          }
          if (actType === "pause" && camp.dailyBudget) {
            mutableGuardrailCtx = {
              ...mutableGuardrailCtx,
              pl: { ...mutableGuardrailCtx.pl, activeDailyBudget: Math.max(0, mutableGuardrailCtx.pl.activeDailyBudget - camp.dailyBudget) },
            };
          }
          logs.push({
            kind: decItem.kind,
            targetName: camp.name,
            campaignId: camp.id,
            rationale: stripEmojis(decItem.rationale),
            status: finalAct.status === "executed" ? "executed" : finalAct.status === "pending" ? "pending" : "failed",
            actionId: finalAct.id,
            detail: finalAct.error ?? (actType === "scale" && gCheck.adjustedBudget ? `Budget -> ${rpk(gCheck.adjustedBudget)}/hari` : null),
          });
          continue;
        }

        if (decItem.kind === "pause_ad") {
          const adObj = dossier.liveAds14d.find((a) => a.id === decItem.adId);
          if (!adObj) {
            logs.push({ kind: "pause_ad", targetName: String(decItem.adName ?? decItem.adId ?? "Iklan"), rationale: decItem.rationale, status: "skipped", detail: "Iklan aktif tidak ditemukan." });
            continue;
          }
          const created = await createPauseAdAction({
            accountId: account.id,
            campaignId: adObj.campaignId,
            adId: adObj.id,
            adName: adObj.name,
            source: "autopilot",
            userId,
            reason: stripEmojis(decItem.rationale),
          });
          const finalAct = autoExec ? await confirmAction(created.id) : created;
          logs.push({
            kind: "pause_ad",
            targetName: adObj.name,
            campaignId: adObj.campaignId,
            adId: adObj.id,
            rationale: stripEmojis(decItem.rationale),
            status: finalAct.status === "executed" ? "executed" : finalAct.status === "pending" ? "pending" : "failed",
            actionId: finalAct.id,
            detail: finalAct.error,
          });
          continue;
        }

        if (decItem.kind === "launch_campaign" || decItem.kind === "inject_ads") {
          if (!dossier.metaInfra.readyForLaunch || !dossier.metaInfra.pageId) {
            logs.push({
              kind: decItem.kind,
              targetName: prod?.name ?? account.name,
              productName: prod?.name ?? null,
              rationale: stripEmojis(decItem.rationale),
              status: "skipped",
              detail: "Infrastruktur peluncuran belum lengkap (pastikan Page/Pixel & minimal 1 aset di Bank Aset Produk tersedia).",
            });
            continue;
          }
          const objective = account.line === "jasa" ? "leads_whatsapp" : "sales";
          if (objective === "sales" && !prod?.url) {
            logs.push({
              kind: decItem.kind,
              targetName: prod?.name ?? account.name,
              rationale: stripEmojis(decItem.rationale),
              status: "skipped",
              detail: "Produk belum memiliki URL halaman produk (linkUrl) di Pengaturan.",
            });
            continue;
          }

          const rawAds = decItem.ads?.length
            ? decItem.ads
            : selectNextAngles(dossier.memories, prod?.id ?? null, 2).map((angle, i) => ({
                angle,
                ...synthesizeCompliantCopy(prod ?? { name: account.name, line: account.line, price: null, profitBeforeAds: null, url: null }, angle),
                assetIndex: i,
              }));

          const built = buildAdItemsFromDecision(rawAds, dossier, prod);
          if (!built.items.length) {
            logs.push({ kind: decItem.kind, targetName: prod?.name ?? account.name, rationale: decItem.rationale, status: "skipped", detail: "Tidak ada aset visual aktif untuk disusun menjadi iklan." });
            continue;
          }

          // Audit kepatuhan kebijakan Meta sebelum menyentuh database / Meta API.
          const targetCpa = account.line === "jasa" ? account.settings.maxCpl : account.settings.maxCpa;
          const budget = gCheck.adjustedBudget ?? decItem.dailyBudget ?? 60_000;
          const preAudit = auditLaunchPlan(
            { objective, dailyBudget: budget, linkUrl: prod?.url ?? undefined, ads: built.items },
            { targetCpa, line: account.line },
          );
          let finalItems = built.items;
          let finalAngles = built.anglesMeta;
          if (preAudit.some((a) => a.check === "Kebijakan Meta Ads" && a.level === "warn") && prod) {
            // Jika teks AI terdeteksi melanggar kebijakan Meta, otomatis ganti dengan copy deterministik patuh kebijakan!
            const safeAds = rawAds.map((r, idx) => ({
              angle: r.angle,
              ...synthesizeCompliantCopy(prod, r.angle),
              assetIndex: r.assetIndex ?? idx,
            }));
            const rebuilt = buildAdItemsFromDecision(safeAds, dossier, prod);
            finalItems = rebuilt.items;
            finalAngles = rebuilt.anglesMeta;
          }

          let finalAct;
          if (decItem.kind === "inject_ads" && camp) {
            const adset = dossier.activeAdsets.find((s) => s.campaignId === camp.id);
            const created = await createAddAdsAction(
              {
                accountId: account.id,
                campaignId: camp.id,
                adsetId: adset?.id,
                objective,
                pageId: dossier.metaInfra.pageId,
                ...(dossier.metaInfra.instagramUserId ? { instagramUserId: dossier.metaInfra.instagramUserId } : {}),
                ...(prod?.url ? { linkUrl: prod.url, autoUtm: true } : {}),
                ads: finalItems,
                startNow: true,
                rationale: stripEmojis(decItem.rationale),
              },
              userId,
              stripEmojis(decItem.rationale),
              "autopilot",
            );
            finalAct = autoExec ? await confirmAction(created.id) : created;
          } else {
            const dateTag = new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "short", timeZone: "Asia/Jakarta" });
            const cName = stripEmojis(decItem.campaignName || `Autopilot ${objective === "sales" ? "Sales" : "Leads"} - ${(prod?.name ?? account.name).slice(0, 32)} - ${dateTag}`);
            const created = await createLaunchAction(
              {
                accountId: account.id,
                campaignName: cName,
                objective,
                dailyBudget: budget,
                pageId: dossier.metaInfra.pageId,
                ...(dossier.metaInfra.instagramUserId ? { instagramUserId: dossier.metaInfra.instagramUserId } : {}),
                ...(dossier.metaInfra.pixelId ? { pixelId: dossier.metaInfra.pixelId } : {}),
                ...(prod?.url ? { linkUrl: prod.url, autoUtm: true } : {}),
                ads: finalItems,
                startNow: true,
                rationale: stripEmojis(decItem.rationale),
              },
              userId,
              stripEmojis(decItem.rationale),
              "autopilot",
            );
            finalAct = autoExec ? await confirmAction(created.id) : created;
          }

          mutableGuardrailCtx = {
            ...mutableGuardrailCtx,
            launchesToday: mutableGuardrailCtx.launchesToday + 1,
            pl: {
              ...mutableGuardrailCtx.pl,
              activeDailyBudget: mutableGuardrailCtx.pl.activeDailyBudget + (decItem.kind === "launch_campaign" ? budget : 0),
            },
          };

          if (built.usedAssetIds.length && (finalAct.status === "executed" || finalAct.status === "pending")) {
            await sql`UPDATE product_assets SET times_used = times_used + 1 WHERE id = ANY(${built.usedAssetIds})`;
          }

          // Catat ke agent_memories agar siklus berikutnya memantau performa angle ini & tidak menduplikasinya.
          if (finalAct.status === "executed" || finalAct.status === "pending") {
            for (const am of finalAngles) {
              await sql`
                INSERT INTO agent_memories (account_id, product_id, campaign_id, action_id, angle, headline, hook_summary, outcome)
                VALUES (${account.id}, ${prod?.id ?? null}, ${finalAct.campaignId ?? null}, ${finalAct.id}, ${am.angle}, ${am.headline}, ${am.hook}, 'testing')`;
            }
          }

          logs.push({
            kind: decItem.kind,
            targetName: finalAct.campaignName ?? decItem.campaignName ?? prod?.name ?? account.name,
            campaignId: finalAct.campaignId,
            productName: prod?.name ?? null,
            angle: finalAngles.map((a) => a.angle).join(", "),
            rationale: stripEmojis(decItem.rationale),
            status: finalAct.status === "executed" ? "executed" : finalAct.status === "pending" ? "pending" : "failed",
            actionId: finalAct.id,
            detail: finalAct.error ?? `${finalItems.length} variasi iklan (${decItem.kind === "launch_campaign" ? `${rpk(budget)}/hari` : "injeksi ad set"})`,
          });
        }
      } catch (err) {
        logs.push({
          kind: decItem.kind,
          targetName: camp?.name ?? prod?.name ?? account.name,
          campaignId: decItem.campaignId ?? null,
          productName: prod?.name ?? null,
          rationale: stripEmojis(decItem.rationale),
          status: "failed",
          detail: errMsg(err),
        });
      }
    }

    const finalStatus: AgentRun["status"] =
      blockedByGuardrail && logs.every((l) => l.status === "blocked_guardrail" || l.status === "skipped")
        ? "halted_guardrail"
        : "completed";
    const guardrailNote = dossier.guardrails.notes.length ? dossier.guardrails.notes.join(" ") : null;

    await sql`
      UPDATE agent_runs
      SET brain = ${planned.brain},
          status = ${finalStatus},
          pl_snapshot = ${sql.json(dossier.pl as any)},
          diagnosis = ${stripEmojis(planned.plan.diagnosis)},
          decisions = ${sql.json(logs as any)},
          guardrail_note = ${guardrailNote},
          input_tokens = ${planned.inputTokens || null},
          output_tokens = ${planned.outputTokens || null},
          finished_at = now()
      WHERE id = ${runId}`;

    await bumpDataVersion();
    emit({ type: "autopilot", accountId: account.id, status: finalStatus });
    return getAgentRunById(runId);
  } catch (e) {
    await sql`
      UPDATE agent_runs
      SET status = 'failed', error = ${errMsg(e).slice(0, 800)}, finished_at = now()
      WHERE id = ${runId}`;
    log.error("siklus autopilot gagal", { account: account.id, error: errMsg(e) });
    emit({ type: "autopilot", accountId: account.id, status: "failed" });
    return getAgentRunById(runId);
  }
}

async function getAgentRunById(id: number): Promise<AgentRun> {
  const [r] = await sql`
    SELECT r.id, r.account_id, a.display_name AS account_name, a.line, r.trigger, r.mode, r.brain, r.status,
           r.pl_snapshot, r.diagnosis, r.decisions, r.guardrail_note, r.input_tokens, r.output_tokens,
           r.started_at, r.finished_at, r.error
    FROM agent_runs r
    JOIN ad_accounts a ON a.id = r.account_id
    WHERE r.id = ${id}`;
  return mapAgentRun(r);
}

function mapAgentRun(r: any): AgentRun {
  return {
    id: Number(r.id),
    accountId: String(r.account_id),
    accountName: String(r.account_name),
    line: r.line as Line,
    trigger: r.trigger,
    mode: r.mode,
    brain: r.brain ?? "ai",
    status: r.status,
    plSnapshot: (r.pl_snapshot as Partial<AgentPlSnapshot>) ?? {},
    diagnosis: r.diagnosis ?? null,
    decisions: Array.isArray(r.decisions) ? r.decisions : [],
    guardrailNote: r.guardrail_note ?? null,
    inputTokens: r.input_tokens ?? null,
    outputTokens: r.output_tokens ?? null,
    startedAt: (r.started_at as Date).toISOString(),
    finishedAt: r.finished_at ? (r.finished_at as Date).toISOString() : null,
    error: r.error ?? null,
  };
}

/** Jalankan siklus evaluasi & optimasi profit pada satu atau semua akun aktif (dikunci advisory lock agar anti-tabrakan). */
export async function runAutopilotCycle(
  trigger: "sync" | "manual" | "chat",
  opts: { accountId?: string; userId?: number | null } = {},
): Promise<{ skippedLock?: boolean; runs: AgentRun[] }> {
  return sql.reserve().then(async (conn) => {
    try {
      const [{ ok }] = await conn`SELECT pg_try_advisory_lock(724003) AS ok`;
      if (!ok) return { skippedLock: true, runs: [] };
      try {
        const cfg = await loadConfig();
        const targets = cfg.accounts.filter((a) => {
          if (!a.active) return false;
          if (opts.accountId) return a.id === opts.accountId;
          // Pada pemicu otomatis (sync), hanya jalankan akun yang mengaktifkan suggest/auto.
          return trigger === "sync" ? a.botMode !== "off" : true;
        });
        if (!targets.length) return { runs: [] };

        const allProducts = await queryProductsWithEcon(cfg);
        const runs: AgentRun[] = [];
        for (const acc of targets) {
          runs.push(await executeAccountCycle(acc, trigger, cfg, allProducts, opts.userId ?? null));
        }
        return { runs };
      } finally {
        await conn`SELECT pg_advisory_unlock(724003)`.catch(() => {});
      }
    } finally {
      conn.release();
    }
  });
}

/* ------------------------------------------------------------------ 7. Query Dashboard Autopilot & Bank Aset Produk */

export async function getAutopilotDashboard(accFilter?: string): Promise<AutopilotResp> {
  const cfg = await loadConfig();
  const scope = resolveScope(accFilter, cfg);
  const targetAccounts = scope.accounts;
  const ids = targetAccounts.map((a) => a.id);

  const [products, assetRows, runRows, memRows, actRows, campCounts, launchCounts, lastRuns] = await Promise.all([
    queryProductsWithEcon(cfg),
    sql`
      SELECT pa.id, pa.product_id, p.name AS product_name, p.line, pa.account_id, a.display_name AS account_name,
             pa.name, pa.kind, pa.image_hash, pa.image_url, pa.video_id, pa.thumbnail_hash, pa.object_story_id,
             pa.notes, pa.times_used, pa.active, pa.created_at
      FROM product_assets pa
      JOIN products p ON p.id = pa.product_id
      LEFT JOIN ad_accounts a ON a.id = pa.account_id
      WHERE pa.active = true AND p.line = ANY(${scope.lines}::business_line[])
      ORDER BY pa.id DESC
      LIMIT 80`,
    ids.length
      ? sql`
        SELECT r.id, r.account_id, a.display_name AS account_name, a.line, r.trigger, r.mode, r.brain, r.status,
               r.pl_snapshot, r.diagnosis, r.decisions, r.guardrail_note, r.input_tokens, r.output_tokens,
               r.started_at, r.finished_at, r.error
        FROM agent_runs r
        JOIN ad_accounts a ON a.id = r.account_id
        WHERE r.account_id = ANY(${ids})
        ORDER BY r.started_at DESC, r.id DESC
        LIMIT 25`
      : Promise.resolve([]),
    ids.length
      ? sql`
        SELECT m.id, m.account_id, a.display_name AS account_name, m.product_id, p.name AS product_name,
               m.campaign_id, c.name AS campaign_name, m.action_id, m.angle, m.headline, m.hook_summary,
               m.outcome, m.metrics, m.lesson, m.created_at, m.updated_at
        FROM agent_memories m
        JOIN ad_accounts a ON a.id = m.account_id
        LEFT JOIN products p ON p.id = m.product_id
        LEFT JOIN campaigns c ON c.id = m.campaign_id
        WHERE m.account_id = ANY(${ids})
        ORDER BY m.updated_at DESC, m.id DESC
        LIMIT 40`
      : Promise.resolve([]),
    ids.length
      ? sql`
        SELECT b.id, b.account_id, a.display_name AS account_name, b.campaign_id, c.name AS campaign_name,
               b.action, b.params, b.source, b.status, b.reason, b.error, b.created_at, b.expires_at, b.executed_at
        FROM bot_actions b
        LEFT JOIN ad_accounts a ON a.id = b.account_id
        LEFT JOIN campaigns c ON c.id = b.campaign_id
        WHERE b.account_id = ANY(${ids}) AND b.source = 'autopilot'
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT 25`
      : Promise.resolve([]),
    ids.length
      ? sql`
        SELECT account_id,
               count(*) FILTER (WHERE status = 'ACTIVE')::int AS active_camps,
               COALESCE(sum(daily_budget) FILTER (WHERE status = 'ACTIVE'), 0)::bigint AS active_budget
        FROM campaigns
        WHERE account_id = ANY(${ids})
        GROUP BY account_id`
      : Promise.resolve([]),
    ids.length
      ? sql`
        SELECT account_id,
               count(*) FILTER (WHERE action IN ('launch','add_ads') AND source = 'autopilot' AND status IN ('executed','pending') AND created_at > now() - interval '24 hours')::int AS launches_today,
               count(*) FILTER (WHERE action IN ('launch','add_ads') AND status = 'failed' AND created_at > now() - interval '7 days')::int AS failed_7d
        FROM bot_actions
        WHERE account_id = ANY(${ids})
        GROUP BY account_id`
      : Promise.resolve([]),
    ids.length
      ? sql`
        SELECT DISTINCT ON (account_id) account_id, started_at, status
        FROM agent_runs
        WHERE account_id = ANY(${ids})
        ORDER BY account_id, started_at DESC, id DESC`
      : Promise.resolve([]),
  ]);

  const rToday = resolveRange(undefined, undefined, "today");
  const r7 = resolveRange(undefined, undefined, "7d");
  const r30 = resolveRange(undefined, undefined, "30d");

  const campMap = new Map(campCounts.map((r) => [String(r.account_id), r]));
  const launchMap = new Map(launchCounts.map((r) => [String(r.account_id), r]));
  const lastRunMap = new Map(lastRuns.map((r) => [String(r.account_id), r]));

  const accountSummaries: AutopilotAccountSummary[] = await Promise.all(
    targetAccounts.map(async (acc) => {
      const s = resolveScope(acc.id, cfg);
      const [t0, t7, t30] = await Promise.all([
        Q.summaryFor(s, rToday, cfg),
        Q.summaryFor(s, r7, cfg),
        Q.summaryFor(s, r30, cfg),
      ]);
      const cm = campMap.get(acc.id);
      const lm = launchMap.get(acc.id);
      const lr = lastRunMap.get(acc.id);
      const pl: AgentPlSnapshot = {
        todayNet: Math.round(t0.kpis.net),
        todaySpend: Math.round(t0.kpis.spend),
        todayRevenue: Math.round(t0.kpis.revenue),
        todayRoas: Math.round(t0.kpis.roas * 100) / 100,
        net7d: Math.round(t7.kpis.net),
        spend7d: Math.round(t7.kpis.spend),
        revenue7d: Math.round(t7.kpis.revenue),
        roas7d: Math.round(t7.kpis.roas * 100) / 100,
        beRoas7d: Math.round(t7.kpis.beRoas * 100) / 100,
        cpa7d: Math.round(t7.kpis.cpa),
        maxCpaBE7d: Math.round(t7.kpis.maxCpaBE),
        cpl7d: Math.round(t7.kpis.cpl),
        closeRate7d: Math.round(t7.kpis.closeRate * 1000) / 10,
        net30d: Math.round(t30.kpis.net),
        roas30d: Math.round(t30.kpis.roas * 100) / 100,
        activeDailyBudget: Number(cm?.active_budget ?? 0),
      };
      const st = acc.settings;
      const stopLossTriggered = Boolean(st.dailyStopLoss != null && st.dailyStopLoss > 0 && pl.todaySpend > 0 && pl.todayNet <= -st.dailyStopLoss);
      const rejectionCircuitOpen = Number(lm?.failed_7d ?? 0) >= 2;
      return {
        account: acc,
        pl,
        activeCampaigns: Number(cm?.active_camps ?? 0),
        launchesToday: Number(lm?.launches_today ?? 0),
        stopLossTriggered,
        rejectionCircuitOpen,
        lastRunAt: lr?.started_at ? (lr.started_at as Date).toISOString() : null,
        lastRunStatus: (lr?.status as AgentRun["status"]) ?? null,
      };
    }),
  );

  return {
    accounts: accountSummaries,
    products: products.filter((p) => scope.lines.includes(p.line)),
    assets: assetRows.map((a): ProductAsset => ({
      id: Number(a.id),
      productId: Number(a.product_id),
      productName: String(a.product_name),
      line: a.line as Line,
      accountId: a.account_id ?? null,
      accountName: a.account_name ?? null,
      name: String(a.name),
      kind: a.kind as ProductAsset["kind"],
      imageHash: a.image_hash ?? null,
      imageUrl: a.image_url ?? null,
      videoId: a.video_id ?? null,
      thumbnailHash: a.thumbnail_hash ?? null,
      objectStoryId: a.object_story_id ?? null,
      notes: a.notes ?? null,
      timesUsed: Number(a.times_used ?? 0),
      active: Boolean(a.active),
      createdAt: (a.created_at as Date).toISOString(),
    })),
    runs: runRows.map(mapAgentRun),
    memories: memRows.map((m): AgentMemory => ({
      id: Number(m.id),
      accountId: String(m.account_id),
      accountName: String(m.account_name),
      productId: m.product_id != null ? Number(m.product_id) : null,
      productName: m.product_name ?? null,
      campaignId: m.campaign_id ?? null,
      campaignName: m.campaign_name ?? null,
      actionId: m.action_id != null ? Number(m.action_id) : null,
      angle: String(m.angle),
      headline: m.headline ?? null,
      hookSummary: m.hook_summary ?? null,
      outcome: m.outcome as AgentMemory["outcome"],
      metrics: (m.metrics as AgentMemory["metrics"]) ?? {},
      lesson: m.lesson ?? null,
      createdAt: (m.created_at as Date).toISOString(),
      updatedAt: (m.updated_at as Date).toISOString(),
    })),
    recentActions: actRows.map(toAction),
  };
}

export const createProductAssetSchema = z.object({
  productId: z.number().int().positive(),
  accountId: z.string().regex(/^\d{5,25}$/).nullable().optional(),
  name: z.string().trim().min(2).max(120),
  kind: z.enum(["image", "video", "post"]),
  mediaId: z.string().max(40).optional(),
  imageHash: z.string().trim().max(120).optional().nullable(),
  imageUrl: z.string().url().max(600).optional().nullable(),
  videoId: z.string().regex(/^\d+$/).optional().nullable(),
  thumbnailHash: z.string().trim().max(120).optional().nullable(),
  objectStoryId: z.string().regex(/^\d+_\d+$/).optional().nullable(),
  notes: z.string().trim().max(300).optional().nullable(),
});

export async function createProductAsset(raw: unknown, userId: number): Promise<{ id: number; note?: string }> {
  const b = createProductAssetSchema.parse(raw);
  const [prod] = await sql`SELECT id, line FROM products WHERE id = ${b.productId} AND active = true`;
  if (!prod) throw new HTTPException(404, { message: "Produk tidak ditemukan atau nonaktif" });

  let imageHash = b.imageHash || null;
  let imageUrl = b.imageUrl || null;
  let videoId = b.videoId || null;
  let thumbnailHash = b.thumbnailHash || null;
  let objectStoryId = b.objectStoryId || null;
  let note: string | undefined;

  if (b.mediaId) {
    if (!b.accountId) throw new HTTPException(400, { message: "Pilih akun iklan tujuan untuk mengunggah file media ke Meta." });
    if (metaMode() === "mcp") {
      const up = await uploadAttachment(b.mediaId, userId, b.accountId);
      if (up.imageHash) imageHash = up.imageHash;
      if (up.videoId) videoId = up.videoId;
      if (up.thumbnailHash) thumbnailHash = up.thumbnailHash;
      note = up.note;
    } else if (!metaConfigured()) {
      imageHash = b.kind === "image" ? `demo_hash_${Date.now()}` : null;
      videoId = b.kind === "video" ? `${Date.now()}` : null;
      note = "Disimpan dalam mode simulasi lokal (Meta belum terhubung).";
    } else {
      throw new HTTPException(400, { message: "Upload langsung file ke Meta membutuhkan jalur MCP Meta. Gunakan URL gambar atau ID kreatif yang sudah ada." });
    }
  }

  if (b.kind === "image" && !imageHash && !imageUrl) {
    throw new HTTPException(400, { message: "Aset gambar membutuhkan upload foto, Image Hash Meta, atau URL gambar publik." });
  }
  if (b.kind === "video" && !videoId) {
    throw new HTTPException(400, { message: "Aset video membutuhkan upload video atau Video ID Meta." });
  }
  if (b.kind === "post" && !objectStoryId) {
    throw new HTTPException(400, { message: "Aset postingan membutuhkan Object Story ID (format PAGEID_POSTID)." });
  }

  const [row] = await sql`
    INSERT INTO product_assets (product_id, account_id, name, kind, image_hash, image_url, video_id, thumbnail_hash, object_story_id, notes, created_by)
    VALUES (${b.productId}, ${b.accountId ?? null}, ${b.name}, ${b.kind}, ${imageHash}, ${imageUrl}, ${videoId}, ${thumbnailHash}, ${objectStoryId}, ${b.notes ?? null}, ${userId})
    RETURNING id`;
  await bumpDataVersion();
  return { id: Number(row.id), note };
}

export async function updateProductAsset(id: number, raw: unknown): Promise<void> {
  const b = z.object({
    name: z.string().trim().min(2).max(120).optional(),
    notes: z.string().trim().max(300).nullable().optional(),
    active: z.boolean().optional(),
  }).parse(raw);
  const res = await sql`
    UPDATE product_assets SET
      name = COALESCE(${b.name ?? null}, name),
      notes = ${b.notes === undefined ? sql`notes` : b.notes},
      active = COALESCE(${b.active ?? null}, active)
    WHERE id = ${id}
    RETURNING id`;
  if (!res.length) throw new HTTPException(404, { message: "Aset tidak ditemukan" });
  await bumpDataVersion();
}
