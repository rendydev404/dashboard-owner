import { describe, expect, it } from "vitest";
import { adRow, decompose, funnel, signals } from "../src/analysis";

const f = (spend: number, impressions: number, clicks: number, results: number, value = 0) => funnel({ spend, impressions, clicks, results, value });

describe("funnel", () => {
  it("CPM, CTR, CVR, biaya per hasil, ROAS", () => {
    expect(f(1_000_000, 40_000, 800, 20, 2_500_000)).toEqual({
      spend: 1_000_000, impressions: 40_000, clicks: 800, results: 20, value: 2_500_000,
      cpm: 25_000, ctr: 2, cpc: 1250, cvr: 2.5, costPerResult: 50_000, metaRoas: 2.5,
    });
  });
  it("tanpa data tidak membagi nol", () => {
    expect(f(0, 0, 0, 0)).toMatchObject({ cpm: 0, ctr: 0, cvr: 0, costPerResult: null, metaRoas: 0 });
  });
});

describe("dekomposisi biaya per hasil", () => {
  it("kenaikan murni dari CTR turun", () => {
    const d = decompose(f(1_000_000, 40_000, 400, 10), f(1_000_000, 40_000, 800, 20))!;
    expect(d.costPerResultChangePct).toBe(100);
    expect(d.mainDriver).toBe("ctr");
    expect(d.contributionPct).toEqual({ cpm: 0, ctr: 100, cvr: 0 });
  });
  it("CPM naik & CVR turun dibagi proporsional", () => {
    // CPM ×1,5 dan CVR ×(1/1,5): biaya per hasil ×2,25, kontribusi 50/50.
    const prev = f(1_000_000, 40_000, 800, 24);
    const cur = f(1_500_000, 40_000, 800, 24);
    const cur2 = f(cur.spend, cur.impressions, cur.clicks, 16);
    const d = decompose(cur2, prev)!;
    expect(d.costPerResultChangePct).toBe(125);
    expect(d.contributionPct).toEqual({ cpm: 50, ctr: 0, cvr: 50 });
  });
  it("tanpa hasil tidak bisa didekomposisi", () => {
    expect(decompose(f(100_000, 1000, 10, 0), f(100_000, 1000, 10, 2))).toBeNull();
  });
});

describe("sinyal", () => {
  it("creative fatigue: CTR turun & CPM naik di paruh kedua", () => {
    const base = f(9_000_000, 300_000, 6000, 150);
    const first = f(500_000, 25_000, 600, 12), second = f(500_000, 18_000, 300, 6);
    const cur = f(1_000_000, 43_000, 900, 18);
    const s = signals(cur, base, base, { first, second });
    expect(s.some((x) => x.includes("creative fatigue"))).toBe(true);
  });
  it("sampel kecil diberi peringatan", () => {
    expect(signals(f(100_000, 5000, 50, 2), f(0, 0, 0, 0), f(0, 0, 0, 0), null)[0]).toMatch(/Sampel kecil/);
  });
});

describe("baris iklan dari Meta", () => {
  // Bentuk respons asli ads_get_ad_entities (level ad), akun produk digital.
  const raw = {
    id: "120250154023060430", name: "Gabungan - Gemini Salah Cara Nanya", effective_status: "PAUSED", campaign_id: "120250126406590430",
    amount_spent: { value: "555860", unit: "IDR" }, impressions: "8504", reach: "5899", frequency: "1.4416", cpm: { value: "65365", unit: "IDR" },
    link_click: "313", landing_page_view: "158", omni_add_to_cart: "30", omni_initiated_checkout: "21", omni_purchase: "16",
    omni_purchase_values: { value: "784000", unit: "IDR" }, lead: null,
    results: { indicator: "actions:offsite_conversion.fb_pixel_purchase", values: [{ attribution_windows: ["default"], value: "16" }] },
    video_p25_watched_actions: "1121", video_p75_watched_actions: "612", video_thruplay_watched_actions: "1062",
    quality_ranking: "UNKNOWN", engagement_rate_ranking: "ABOVE_AVERAGE", conversion_rate_ranking: "UNKNOWN",
  };
  it("metrik funnel & video", () => {
    const a = adRow(raw, "digital");
    expect(a).toMatchObject({
      spend: 555_860, impressions: 8504, frequency: 1.44, cpm: 65_365, ctrLink: 3.68, landingRate: 50.5,
      addToCart: 30, checkout: 21, results: 16, costPerResult: 34_741, metaRoas: 1.41,
      video: { holdRate25: 13.2, p75OfP25: 54.6, thruplayRate: 12.5 },
      rankings: { quality: null, engagement: "above_average", conversion: null },
    });
  });
  it("akun jasa memakai lead/results, tanpa ROAS pixel", () => {
    const a = adRow({ ...raw, omni_purchase: "0", lead: null, results: { values: [{ value: "7" }] } }, "jasa");
    expect(a.results).toBe(7);
    expect(a.metaRoas).toBeNull();
  });
});
