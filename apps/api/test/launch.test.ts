import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { tool: string; args: any }[] = [];
let failAt: string | null = null;
let videoState = "ready";
vi.mock("../src/meta/mcp", () => ({
  conversationId: () => "conv-test",
  unwrap: (x: unknown) => (typeof x === "string" && /^\s*[\[{]/.test(x) ? JSON.parse(x) : x),
  callTool: vi.fn(async (tool: string, args: any) => {
    calls.push({ tool, args });
    if (tool === failAt) throw new Error(`gagal di ${tool}`);
    switch (tool) {
      case "ads_create_campaign": {
        const goals: Record<string, string[]> = { OUTCOME_SALES: ["OFFSITE_CONVERSIONS", "VALUE"], OUTCOME_TRAFFIC: ["LANDING_PAGE_VIEWS", "LINK_CLICKS"], OUTCOME_LEADS: ["OFFSITE_CONVERSIONS", "CONVERSATIONS"] };
        const valid = goals[args.objective] ?? [];
        return { campaign_id: "c1", status: "DRAFT", valid_optimization_goals: valid, recommended_optimization_goal: valid[0] };
      }
      case "ads_create_ad_set": return { ad_set_id: "s1", status: "DRAFT" };
      case "ads_create_creative": return { creative_id: `k${calls.filter((x) => x.tool === "ads_create_creative").length}` };
      case "ads_create_ad": return { ad_id: `a${calls.filter((x) => x.tool === "ads_create_ad").length}`, status: "DRAFT" };
      case "ads_activate_entity": return { status: "ACTIVE" };
      case "ads_update_entity": return { status: "PAUSED" };
      case "ads_get_ad_videos": return { ad_videos: [{ id: "4476160626027557", picture: "https://fbcdn/t160.jpg", status: { video_status: videoState } }] };
    }
    return {};
  }),
}));

const { executeLaunch, launchPlanSchema } = await import("../src/meta/launch");

const plan = launchPlanSchema.parse({
  accountId: "1392053332395676", campaignName: "Penjualan - Timelapse AI - 21 Okt", objective: "sales", dailyBudget: 150000,
  pageId: "111", pixelId: "222", linkUrl: "https://lynk.id/x/timelapse", adName: "Timelapse - Hook A",
  creative: { type: "new", imageUrl: "https://cdn.example.com/a.jpg", primaryText: "Bikin video timelapse AI dalam 10 menit.", headline: "Tutorial Timelapse AI", cta: "SHOP_NOW" },
});

beforeEach(() => { calls.length = 0; failAt = null; });

describe("executeLaunch", () => {
  it("urutan draft → publish dengan parameter best practice", async () => {
    const r = await executeLaunch(plan);
    expect(calls.map((c) => c.tool)).toEqual(["ads_create_campaign", "ads_create_ad_set", "ads_create_creative", "ads_create_ad", "ads_activate_entity"]);
    expect(calls[0].args).toMatchObject({ objective: "OUTCOME_SALES", buying_type: "AUCTION", campaign_daily_budget: 150000, campaign_bid_strategy: "LOWEST_COST_WITHOUT_CAP" });
    const adset = calls[1].args;
    expect(adset).toMatchObject({ campaign_id: "c1", billing_event: "IMPRESSIONS", optimization_goal: "OFFSITE_CONVERSIONS", destination_type: "WEBSITE" });
    expect(adset.daily_budget).toBeUndefined(); // CBO: budget hanya di kampanye
    expect(JSON.parse(adset.promoted_object)).toEqual({ pixel_id: "222", custom_event_type: "PURCHASE" });
    expect(JSON.parse(adset.targeting)).toEqual({ geo_locations: { countries: ["ID"] }, age_min: 18, age_max: 65 }); // tanpa interest → broad + A+A
    expect(calls[2].args).toMatchObject({ page_id: "111", image_url: "https://cdn.example.com/a.jpg", call_to_action_type: "SHOP_NOW", link_url: "https://lynk.id/x/timelapse" });
    expect(JSON.parse(calls[3].args.creative)).toEqual({ creative_id: "k1" });
    expect(calls[4].args).toMatchObject({ entity_id: "c1", entity_type: "campaign", publish_as_active: true });
    expect(r).toMatchObject({ campaignId: "c1", adsetId: "s1", creativeId: "k1", adId: "a1", published: true });
    expect(r.steps.every((s) => s.ok)).toBe(true);
  });

  it("berhenti di langkah gagal dan tidak pernah publish", async () => {
    failAt = "ads_create_creative";
    const r = await executeLaunch(plan);
    expect(calls.map((c) => c.tool)).toEqual(["ads_create_campaign", "ads_create_ad_set", "ads_create_creative"]);
    expect(r.published).toBe(false);
    expect(r.steps.at(-1)).toMatchObject({ step: "creative", ok: false });
  });

  it("startNow=false menyimpan draft tanpa publish; kreatif lama dipakai ulang tanpa membuat baru", async () => {
    const r = await executeLaunch({ ...plan, startNow: false, creative: { type: "existing", creativeId: "999" } });
    expect(calls.map((c) => c.tool)).toEqual(["ads_create_campaign", "ads_create_ad_set", "ads_create_ad"]);
    expect(JSON.parse(calls[2].args.creative)).toEqual({ creative_id: "999" });
    expect(r.published).toBe(false);
    expect(r.steps.at(-1)).toMatchObject({ step: "publish", ok: true });
  });

  it("WhatsApp: leads + CONVERSATIONS ke WHATSAPP, kreatif tanpa link", async () => {
    await executeLaunch(launchPlanSchema.parse({ ...plan, objective: "leads_whatsapp", pixelId: undefined, linkUrl: undefined, creative: { ...plan.creative, cta: "WHATSAPP_MESSAGE" } }));
    expect(calls[0].args.objective).toBe("OUTCOME_LEADS");
    expect(calls[1].args).toMatchObject({ destination_type: "WHATSAPP" });
    expect(JSON.parse(calls[1].args.promoted_object)).toEqual({ page_id: "111" });
    expect(calls[2].args.link_url).toBeUndefined();
  });

  it("skema menolak rencana tanpa kreatif atau dengan budget tidak bulat", () => {
    expect(launchPlanSchema.safeParse({ ...plan, creative: undefined }).success).toBe(false);
    expect(launchPlanSchema.safeParse({ ...plan, dailyBudget: 1500.5 }).success).toBe(false);
  });
});

describe("explain", () => {
  it("menambahkan petunjuk katalog untuk error set produk", async () => {
    const { explain } = await import("../src/meta/launch");
    expect(explain('{"error_subcode":"2310081","error_message":"Set produk tidak valid"}')).toMatch(/katalog/);
    expect(explain("error lain")).toBe("error lain");
  });
});

describe("traffic", () => {
  it("tidak mengirim promoted_object (ditolak Meta untuk LANDING_PAGE_VIEWS)", async () => {
    calls.length = 0; failAt = null;
    await executeLaunch(launchPlanSchema.parse({ ...plan, objective: "traffic" }));
    const adset = calls.find((c) => c.tool === "ads_create_ad_set")!.args;
    expect(adset).toMatchObject({ optimization_goal: "LANDING_PAGE_VIEWS", destination_type: "WEBSITE" });
    expect(adset.promoted_object).toBeUndefined();
  });
});

describe("iklan video dari lampiran chat", () => {
  const video = (extra: object = {}) => launchPlanSchema.parse({
    ...plan, objective: "leads_whatsapp", pixelId: undefined, linkUrl: undefined,
    creative: { type: "new", videoId: "4476160626027557", primaryText: "Video promosi jadi 1x24 jam, mulai Rp250 rb.", headline: "Jasa Video AI", cta: "WHATSAPP_MESSAGE", ...extra },
  });
  beforeEach(() => { calls.length = 0; failAt = null; videoState = "ready"; });

  it("cover dari browser (imageHash) dipakai sebagai thumbnail, tanpa cek video ke Meta", async () => {
    await executeLaunch(video({ imageHash: "cover-hash" }));
    const cr = calls.find((c) => c.tool === "ads_create_creative")!.args;
    expect(cr).toMatchObject({ video_id: "4476160626027557", image_hash: "cover-hash", call_to_action_type: "WHATSAPP_MESSAGE" });
    expect(cr.image_url).toBeUndefined();
    expect(calls.some((c) => c.tool === "ads_get_ad_videos")).toBe(false);
  });

  it("tanpa cover: thumbnail Meta dipakai setelah video siap", async () => {
    const r = await executeLaunch(video());
    expect(calls[0].tool).toBe("ads_get_ad_videos");
    expect(calls.find((c) => c.tool === "ads_create_creative")!.args).toMatchObject({ video_id: "4476160626027557", image_url: "https://fbcdn/t160.jpg" });
    expect(r.steps.every((s) => s.ok)).toBe(true);
  });

  it("video masih diproses: tidak ada yang dibuat, dan konfirmasi ditolak 409 tanpa menghanguskan aksi", async () => {
    videoState = "processing";
    const r = await executeLaunch(video());
    expect(calls.map((c) => c.tool)).toEqual(["ads_get_ad_videos"]);
    expect(r.campaignId).toBeNull();
    expect(r.steps[0]).toMatchObject({ step: "creative", ok: false });
    const { assertLaunchMediaReady } = await import("../src/meta/launch");
    await expect(assertLaunchMediaReady(video())).rejects.toMatchObject({ status: 409 });
    videoState = "ready";
    await expect(assertLaunchMediaReady(video())).resolves.toBeUndefined();
    await expect(assertLaunchMediaReady(video({ imageHash: "cover-hash" }))).resolves.toBeUndefined();
  });
});

describe("multi-iklan CBO, injeksi kampanye eksisting, UTM, & pre-flight audit", () => {
  beforeEach(() => { calls.length = 0; failAt = null; videoState = "ready"; });

  it("multi-variasi (ads 3 angle) digabung dalam 1 kampanye CBO + 1 ad set dengan autoUtm per iklan", async () => {
    const multiPlan = launchPlanSchema.parse({
      accountId: "1392053332395676",
      campaignName: "Penjualan - Prompt AI - 26 Okt",
      objective: "sales",
      dailyBudget: 200000,
      pageId: "111",
      pixelId: "222",
      linkUrl: "https://lynk.id/x/prompt-ai",
      autoUtm: true,
      ads: [
        { adName: "Poster V1 - Angle Waktu", creative: { type: "new", imageHash: "h1", primaryText: "Potong waktu riset konten dari 3 jam jadi 10 menit pakai paket prompt siap pakai.", headline: "Paket Prompt AI Instan", cta: "SHOP_NOW" } },
        { adName: "Poster V1 - Angle Hasil", creative: { type: "new", imageHash: "h1", primaryText: "Lebih dari 500 kreator sudah merapikan alur produksi konten harian tanpa ribet.", headline: "Akses Otomatis Rp49rb", cta: "SHOP_NOW" } },
        { adName: "Kreatif Lama Juara", creative: { type: "existing", creativeId: "777" } },
      ],
    });
    const r = await executeLaunch(multiPlan);
    expect(r.published).toBe(true);
    expect(r.creativeIds).toEqual(["k1", "k2", "777"]);
    expect(r.adIds).toEqual(["a1", "a2", "a3"]);
    // Hanya 1 kampanye & 1 ad set dibuat, lalu 2 kreatif baru + 3 iklan + 1 aktivasi kampanye
    expect(calls.map((c) => c.tool)).toEqual([
      "ads_create_campaign", "ads_create_ad_set",
      "ads_create_creative", "ads_create_ad",
      "ads_create_creative", "ads_create_ad",
      "ads_create_ad",
      "ads_activate_entity",
    ]);
    const cr1Link = calls[2].args.link_url as string;
    const cr2Link = calls[4].args.link_url as string;
    expect(cr1Link).toContain("utm_source=meta");
    expect(cr1Link).toContain("utm_content=poster-v1-angle-waktu");
    expect(cr2Link).toContain("utm_content=poster-v1-angle-hasil");
  });

  it("executeAddAds menyuntikkan iklan baru ke ad set eksisting & pauseAddedAds menjedanya saat revert", async () => {
    const { addAdsPlanSchema, executeAddAds, pauseAddedAds } = await import("../src/meta/launch");
    const addPlan = addAdsPlanSchema.parse({
      accountId: "1392053332395676",
      campaignId: "9001",
      campaignName: "Kampanye Pemenang",
      objective: "sales",
      pageId: "111",
      linkUrl: "https://lynk.id/x/timelapse",
      autoUtm: true,
      ads: [
        { adName: "Refresh Hook A", creative: { type: "new", imageHash: "h-new-1", primaryText: "Bikin video timelapse properti realistis hanya dari 1 foto ruangan dalam hitungan menit.", headline: "Template Timelapse AI", cta: "SHOP_NOW" } },
        { adName: "Refresh Hook B", creative: { type: "new", imageHash: "h-new-2", primaryText: "Tanpa software 3D berat, langsung akses panduan langkah demi langkah setelah checkout.", headline: "Akses Instan Tutorial AI", cta: "SHOP_NOW" } },
      ],
    });
    const res = await executeAddAds({ ...addPlan, adsetId: "8001" });
    expect(res).toMatchObject({ campaignId: "9001", adsetId: "8001", adIds: ["a1", "a2"], published: true });
    expect(calls.filter((c) => c.tool === "ads_activate_entity").map((c) => c.args.entity_id)).toEqual(["a1", "a2"]);

    calls.length = 0;
    await pauseAddedAds("1392053332395676", res.adIds!);
    expect(calls.map((c) => ({ tool: c.tool, id: c.args.entity_id }))).toEqual([
      { tool: "ads_update_entity", id: "a1" },
      { tool: "ads_update_entity", id: "a2" },
    ]);
  });

  it("auditLaunchPlan mendeteksi pelanggaran kebijakan Meta, headline > 40 karakter, & rasio budget vs CPA", async () => {
    const { auditLaunchPlan } = await import("../src/meta/launch");
    const risky = auditLaunchPlan(
      {
        objective: "sales",
        dailyBudget: 20000,
        linkUrl: "https://lynk.id/x/produk",
        ads: [{
          adName: "Iklan Rawan",
          creative: {
            type: "new",
            imageHash: "h1",
            primaryText: "Buat kamu yang masih boncos terus setiap hari, pakai cara ini dijamin cuan setiap minggu!",
            headline: "Headline Ini Sangat Panjang Sekali Sampai Pasti Terpotong Di Layar HP",
            cta: "SHOP_NOW",
          },
        }],
      },
      { targetCpa: 50000, line: "digital" },
    );
    const warns = risky.filter((x) => x.level === "warn").map((x) => x.check);
    expect(warns).toEqual(expect.arrayContaining(["Kebijakan Meta Ads", "Panjang Headline", "Rasio Budget vs CPA"]));

    const clean = auditLaunchPlan(
      {
        objective: "sales",
        dailyBudget: 120000,
        linkUrl: "https://lynk.id/x/produk",
        ads: [
          { adName: "Angle 1", creative: { type: "new", imageHash: "h1", primaryText: "Pangkas waktu pembuatan desain katalog produk dari 2 jam menjadi 5 menit saja.", headline: "Akses Instan Paket AI", cta: "SHOP_NOW" } },
          { adName: "Angle 2", creative: { type: "new", imageHash: "h1", primaryText: "Sudah termasuk 120 template siap pakai dan panduan video singkat bahasa Indonesia.", headline: "Siap Pakai Tanpa Ribet", cta: "SHOP_NOW" } },
        ],
      },
      { targetCpa: 50000, line: "digital" },
    );
    expect(clean.every((x) => x.level === "ok")).toBe(true);
  });
});
