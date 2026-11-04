import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { DEFAULT_SETTINGS, type Account, type AgentPlSnapshot } from "@iklan/shared";

process.env.DATABASE_URL ??= "postgres://test@127.0.0.1:1/test";

const {
  CANONICAL_ANGLES,
  aiPlanOutputSchema,
  buildDeterministicProfitPlan,
  checkDecisionGuardrail,
  computeProductUnitEconomics,
  evaluateExperimentOutcome,
  evaluateGuardrails,
  selectNextAngles,
  synthesizeCompliantCopy,
} = await import("../src/autopilot");
const { auditLaunchPlan } = await import("../src/meta/launch");
const { mcpHandler } = await import("../src/mcp-server");
const { openChatSession, closeChatSession } = await import("../src/chat-sessions");

const basePl = (over: Partial<AgentPlSnapshot> = {}): AgentPlSnapshot => ({
  todayNet: 50_000,
  todaySpend: 100_000,
  todayRevenue: 200_000,
  todayRoas: 2.0,
  net7d: 450_000,
  spend7d: 700_000,
  revenue7d: 1_500_000,
  roas7d: 2.14,
  beRoas7d: 1.35,
  cpa7d: 35_000,
  maxCpaBE7d: 75_000,
  cpl7d: 0,
  closeRate7d: 0,
  net30d: 1_800_000,
  roas30d: 2.2,
  activeDailyBudget: 200_000,
  ...over,
});

describe("computeProductUnitEconomics", () => {
  it("menghitung margin unit, batas CPA impas (termasuk PPN iklan), dan ROAS impas dengan presisi", () => {
    const u = computeProductUnitEconomics({
      id: 1,
      line: "digital",
      name: "Bundle Prompt Video AI",
      price: 100_000,
      cogs: 10_000,
      url: "https://lynk.id/toko/bundle-ai",
      sold30d: 42,
      revenue30d: 4_200_000,
      assetCount: 3,
      feePct: 5,
      adTaxPct: 11,
    });
    // Harga 100rb - HPP 10rb - Fee 5rb = Margin sebelum iklan 85rb
    expect(u.profitBeforeAds).toBe(85_000);
    // CPA impas = floor(85.000 / 1.11) = 76.576
    expect(u.maxBreakEvenCpa).toBe(76_576);
    // ROAS impas = round((100.000 * 1.11 / 85.000) * 100) / 100 = 1.31
    expect(u.breakEvenRoas).toBe(1.31);
  });

  it("menangani jasa harga variabel dan produk margin negatif secara aman", () => {
    const jasa = computeProductUnitEconomics({
      id: 2, line: "jasa", name: "Jasa Otomasi AI Custom", price: null, cogs: 500_000,
      url: null, sold30d: 3, revenue30d: 9_000_000, assetCount: 1, feePct: 0, adTaxPct: 3,
    });
    expect(jasa.profitBeforeAds).toBeNull();
    expect(jasa.maxBreakEvenCpa).toBeNull();
    expect(jasa.breakEvenRoas).toBeNull();

    const neg = computeProductUnitEconomics({
      id: 3, line: "digital", name: "Produk Rugi", price: 50_000, cogs: 50_000,
      url: "https://lynk.id/x", sold30d: 0, revenue30d: 0, assetCount: 0, feePct: 5, adTaxPct: 3,
    });
    expect(neg.profitBeforeAds).toBe(-2_500);
    expect(neg.maxBreakEvenCpa).toBeNull();
    expect(neg.breakEvenRoas).toBeNull();
  });
});

describe("Guardrail & Safety Circuit Breakers", () => {
  it("stop-loss harian memblokir scale & launch, tetapi mengizinkan pause iklan/kampanye boncos (bahkan menembus cooldown)", () => {
    const now = 1_700_000_000_000;
    const ctx = {
      settings: { ...DEFAULT_SETTINGS.digital, dailyStopLoss: 300_000, cooldownHours: 6, killAfterSpend: 100_000 },
      pl: basePl({ todaySpend: 400_000, todayNet: -340_000 }),
      hourWib: 14,
      launchesToday: 0,
      failedLaunches7d: 0,
      lastActionMsByCampaign: new Map([["camp_bleed", now - 30 * 60_000]]), // baru 30 menit lalu disentuh
      campaignAgeDays: new Map([["camp_bleed", 5]]),
      nowMs: now,
    };

    const st = evaluateGuardrails(ctx);
    expect(st.stopLossTriggered).toBe(true);

    expect(checkDecisionGuardrail({ kind: "scale_campaign", campaignId: "camp_ok", currentDailyBudget: 100_000 }, ctx, st).ok).toBe(false);
    expect(checkDecisionGuardrail({ kind: "launch_campaign", dailyBudget: 75_000 }, ctx, st).ok).toBe(false);
    expect(checkDecisionGuardrail({ kind: "inject_ads", campaignId: "camp_ok" }, ctx, st).ok).toBe(false);

    // Pause darurat pada kampanye boncos tetap diizinkan demi menghentikan pendarahan saldo!
    expect(checkDecisionGuardrail({ kind: "pause_campaign", campaignId: "camp_bleed", spend: 150_000 }, ctx, st).ok).toBe(true);
    expect(checkDecisionGuardrail({ kind: "pause_ad", campaignId: "camp_bleed", spend: 120_000 }, ctx, st).ok).toBe(true);
  });

  it("melindungi fase belajar (< 3 hari & spend < killAfterSpend), memblokir jam mati, cooldown, plafon akun, dan circuit breaker Meta", () => {
    const now = 1_700_000_000_000;
    const ctx = {
      settings: {
        ...DEFAULT_SETTINGS.digital,
        maxDailyBudget: 150_000,
        maxAccountDailyBudget: 250_000,
        cooldownHours: 6,
        killAfterSpend: 100_000,
      },
      pl: basePl({ activeDailyBudget: 220_000 }), // sisa plafon akun tinggal 30rb
      hourWib: 3, // jam sepi 03:00 WIB
      launchesToday: 0,
      failedLaunches7d: 2, // circuit breaker Meta terbuka
      lastActionMsByCampaign: new Map([["camp_recent", now - 2 * 3_600_000]]),
      campaignAgeDays: new Map([["camp_new", 1]]),
      nowMs: now,
    };

    // Fase belajar dilindungi jika spend < killAfterSpend
    expect(checkDecisionGuardrail({ kind: "pause_campaign", campaignId: "camp_new", spend: 45_000 }, ctx).ok).toBe(false);
    // Namun boleh dimatikan jika sudah membakar spend >= killAfterSpend meski baru 1 hari
    expect(checkDecisionGuardrail({ kind: "pause_campaign", campaignId: "camp_new", spend: 120_000 }, ctx).ok).toBe(true);

    // Cooldown aktif (2 jam < 6 jam)
    expect(checkDecisionGuardrail({ kind: "pause_campaign", campaignId: "camp_recent", spend: 120_000 }, ctx).ok).toBe(false);

    // Jam mati 03:00 WIB menahan scale_campaign
    expect(checkDecisionGuardrail({ kind: "scale_campaign", campaignId: "camp_other", currentDailyBudget: 100_000 }, ctx).ok).toBe(false);

    // Circuit breaker penolakan Meta (>= 2 gagal) menahan peluncuran baru
    expect(checkDecisionGuardrail({ kind: "launch_campaign", dailyBudget: 50_000 }, ctx).ok).toBe(false);

    // Pada siang hari & tanpa gagal Meta, peluncuran otomatis menyesuaikan sisa plafon akun (30rb)
    const dayCtx = { ...ctx, hourWib: 11, failedLaunches7d: 0 };
    const launchCheck = checkDecisionGuardrail({ kind: "launch_campaign", dailyBudget: 90_000 }, dayCtx);
    expect(launchCheck).toEqual({ ok: true, adjustedBudget: 30_000 });
    // Scale +50% (delta +50rb > sisa 30rb) ditolak plafon akun
    expect(checkDecisionGuardrail({ kind: "scale_campaign", campaignId: "camp_other", currentDailyBudget: 100_000, scalePct: 50 }, dayCtx).ok).toBe(false);
  });
});

describe("Memori Eksperimen Angle & Copywriting Patuh Meta", () => {
  it("mengevaluasi eksperimen winning vs losing beserta diagnosis akar masalah CTR vs konversi", () => {
    const st = DEFAULT_SETTINGS.digital;
    const win = evaluateExperimentOutcome(
      { spend: 120_000, impressions: 6_000, clicks: 150, results: 4, revenue: 400_000, ageDays: 4 },
      { line: "digital", settings: st, maxBreakEvenCpa: 75_000 },
    );
    expect(win.outcome).toBe("winning");

    const weakHook = evaluateExperimentOutcome(
      { spend: 130_000, impressions: 15_000, clicks: 60, results: 0, revenue: 0, ageDays: 4 }, // CTR 0.4%
      { line: "digital", settings: st, maxBreakEvenCpa: 75_000 },
    );
    expect(weakHook.outcome).toBe("losing");
    expect(weakHook.lesson).toContain("CTR tautan rendah");

    const weakOffer = evaluateExperimentOutcome(
      { spend: 160_000, impressions: 5_000, clicks: 125, results: 1, revenue: 99_000, ageDays: 5 }, // CTR 2.5%, CPA 160rb > impas 75rb
      { line: "digital", settings: st, maxBreakEvenCpa: 75_000 },
    );
    expect(weakOffer.outcome).toBe("losing");
    expect(weakOffer.lesson).toContain("konversi pasca-klik lemah");
  });

  it("selectNextAngles tidak pernah mengulang angle yang losing/testing dan berevolusi saat semua angle dasar habis", () => {
    const next = selectNextAngles(
      [
        { productId: 1, angle: "pain_agitation", outcome: "losing" },
        { productId: 1, angle: "outcome_mechanism", outcome: "testing" },
      ],
      1,
      2,
    );
    expect(next).toEqual(["direct_offer", "qualification_proof"]);

    const exhausted = CANONICAL_ANGLES.map((a, i) => ({
      productId: 1,
      angle: a,
      outcome: (i === 0 ? "winning" : "losing") as "winning" | "losing",
    }));
    const evolved = selectNextAngles(exhausted, 1, 2);
    expect(evolved[0]).toBe("pain_agitation_v2");
    expect(evolved).toHaveLength(2);
  });

  it("seluruh angle synthesizeCompliantCopy bebas emoji, headline <= 40 karakter, dan lolos audit kebijakan Meta", () => {
    for (const line of ["digital", "jasa"] as const) {
      const prod = {
        name: line === "digital" ? "Template Konten AI Otomatis" : "Jasa Pembuatan Chatbot WhatsApp AI",
        line,
        price: line === "digital" ? 99_000 : 2_500_000,
        profitBeforeAds: line === "digital" ? 90_000 : 1_800_000,
        url: line === "digital" ? "https://lynk.id/creator/template-ai" : null,
      };
      for (const angle of CANONICAL_ANGLES) {
        const copy = synthesizeCompliantCopy(prod, angle);
        expect(copy.headline.length).toBeLessThanOrEqual(40);
        expect(copy.primaryText).not.toMatch(/[\p{Extended_Pictographic}]/u);
        expect(copy.headline).not.toMatch(/[\p{Extended_Pictographic}]/u);

        const audit = auditLaunchPlan(
          {
            objective: line === "jasa" ? "leads_whatsapp" : "sales",
            dailyBudget: line === "jasa" ? 150_000 : 100_000,
            linkUrl: prod.url ?? undefined,
            ads: [{
              adName: copy.adName,
              creative: {
                type: "new",
                imageHash: "hash_123",
                primaryText: copy.primaryText,
                headline: copy.headline,
                description: copy.description,
                cta: copy.cta,
              },
            }],
          },
          { targetCpa: line === "jasa" ? 60_000 : 45_000, line },
        );
        const policyWarns = audit.filter((a) => a.check === "Kebijakan Meta Ads" && a.level === "warn");
        expect(policyWarns).toEqual([]);
      }
    }
  });
});

describe("buildDeterministicProfitPlan (Push-to-Profit End-to-End)", () => {
  it("memangkas kampanye & iklan boncos, men-scale pemenang, dan meluncurkan kampanye pengganti ber-angle segar", () => {
    const account: Account = {
      id: "1392053332395676",
      name: "Digital Store Utama",
      line: "digital",
      resultActionType: "omni_purchase",
      botMode: "auto",
      active: true,
      timezone: "Asia/Jakarta",
      lastSyncedAt: new Date().toISOString(),
      settings: { ...DEFAULT_SETTINGS.digital },
    };
    const pl = basePl({ net7d: -180_000, spend7d: 620_000, revenue7d: 500_000, roas7d: 0.81 });
    const guardrailCtx = {
      settings: account.settings,
      pl,
      hourWib: 13,
      launchesToday: 0,
      failedLaunches7d: 0,
      lastActionMsByCampaign: new Map<string, number>(),
      campaignAgeDays: new Map([["c_lose", 6], ["c_win", 10]]),
    };

    const plan = buildDeterministicProfitPlan({
      account,
      pl,
      guardrailCtx,
      guardrails: evaluateGuardrails(guardrailCtx),
      products: [
        computeProductUnitEconomics({
          id: 10, line: "digital", name: "Kelas Video AI Masterclass", price: 149_000, cogs: 0,
          url: "https://lynk.id/store/video-ai", sold30d: 35, revenue30d: 5_215_000, assetCount: 2, feePct: 5, adTaxPct: 3,
        }),
      ],
      campaigns7d: [
        {
          id: "c_lose", name: "Sales - Angle Lama Boncos", status: "ACTIVE", dailyBudget: 100_000, ageDays: 6,
          spend7d: 240_000, results7d: 1, cpa7d: 240_000, roas7d: 0.62, ctrPct7d: 0.55, spend3d: 120_000, results3d: 0, recCode: "kill",
        },
        {
          id: "c_win", name: "Sales - Winner CBO", status: "ACTIVE", dailyBudget: 100_000, ageDays: 10,
          spend7d: 380_000, results7d: 12, cpa7d: 31_667, roas7d: 3.9, ctrPct7d: 2.1, spend3d: 160_000, results3d: 5, recCode: "scale",
        },
      ],
      liveAds14d: [
        { id: "ad_bad_1", name: "Variasi Hook Lemah", campaignId: "c_win", spend: 95_000, results: 0, costPerResult: null, ctrLink: 0.4 },
      ],
      activeAdsets: [{ id: "as_1", name: "Broad ID", campaignId: "c_win" }],
      metaInfra: { readyForLaunch: true, demoMode: false, pageId: "1001", instagramUserId: "2002", pixelId: "3003" },
      creativePool: [
        { assetId: 501, productId: 10, name: "Poster Masterclass 1", kind: "image", imageHash: "h_501", timesUsed: 0 },
        { assetId: 502, productId: 10, name: "Poster Masterclass 2", kind: "image", imageHash: "h_502", timesUsed: 1 },
      ],
      memories: [
        { id: 1, productId: 10, productName: "Kelas Video AI Masterclass", campaignId: "c_lose", angle: "pain_agitation", headline: "Lama", outcome: "losing", lesson: "CTR rendah", metrics: {} },
      ],
      funnelSignals: ["CTR tautan c_lose turun ke 0,55%"],
    });

    // Valid terhadap kontrak schema AI planner
    expect(() => aiPlanOutputSchema.parse(plan)).not.toThrow();

    const kinds = plan.decisions.map((d) => d.kind);
    expect(kinds).toEqual(["pause_ad", "pause_campaign", "launch_campaign", "scale_campaign"]);

    const launch = plan.decisions.find((d) => d.kind === "launch_campaign")!;
    expect(launch.productId).toBe(10);
    expect(launch.ads).toHaveLength(2);
    // Tidak memakai pain_agitation yang sudah terbukti losing!
    expect(launch.ads!.map((a) => a.angle)).toEqual(["outcome_mechanism", "direct_offer"]);
  });

  it("mendaftarkan tool MCP Autopilot di server MCP internal", async () => {
    const app = new Hono().post("/internal/mcp", mcpHandler);
    const tok = openChatSession({
      user: { id: 1, email: "o@x", name: "Owner", role: "owner" },
      ctx: { acc: "all", from: "2026-10-14", to: "2026-10-20" },
      emit: () => {},
    });
    const res = await app.request("/internal/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = await res.json();
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_autopilot_status", "run_autopilot_now", "configure_autopilot"]));
    closeChatSession(tok);
  });
});
