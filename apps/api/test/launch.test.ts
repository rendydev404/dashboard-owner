import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { tool: string; args: any }[] = [];
let failAt: string | null = null;
vi.mock("../src/meta/mcp", () => ({
  conversationId: () => "conv-test",
  unwrap: (x: unknown) => (typeof x === "string" && /^\s*[\[{]/.test(x) ? JSON.parse(x) : x),
  callTool: vi.fn(async (tool: string, args: any) => {
    calls.push({ tool, args });
    if (tool === failAt) throw new Error(`gagal di ${tool}`);
    switch (tool) {
      case "ads_create_campaign": return { campaign_id: "c1", status: "DRAFT", valid_optimization_goals: ["OFFSITE_CONVERSIONS", "VALUE"], recommended_optimization_goal: "OFFSITE_CONVERSIONS" };
      case "ads_create_ad_set": return { ad_set_id: "s1", status: "DRAFT" };
      case "ads_create_creative": return { creative_id: "k1" };
      case "ads_create_ad": return { ad_id: "a1", status: "DRAFT" };
      case "ads_activate_entity": return { status: "ACTIVE" };
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
