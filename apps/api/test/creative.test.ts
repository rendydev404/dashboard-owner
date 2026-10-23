import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://test@127.0.0.1:1/test"; // modul db dibuat tanpa koneksi; tes ini tidak menyentuh DB
const { parsePrice, videoAdInput } = await import("../src/creative");

describe("parsePrice (harga di video harus cocok dengan data produk)", () => {
  it.each([
    ["Rp49rb", 49_000], ["Rp 49.000", 49_000], ["49k", 49_000], ["Rp1,2jt", 1_200_000], ["Rp 149.900", 149_900], ["Rp2 juta", 2_000_000], ["Rp99ribu", 99_000],
  ])("%s → %d", (s, n) => expect(parsePrice(s)).toBe(n));
  it("tanpa angka → null", () => expect(parsePrice("Gratis!")).toBeNull());
});

describe("videoAdInput", () => {
  const ok = {
    accountId: "1392053332395676", hook: "Bikin timelapse pakai AI", cta: "Klik link di bawah", mediaIds: ["m_1"],
    script: "Capek bikin video yang itu-itu aja? Sekarang bisa pakai AI, cuma sepuluh menit.",
    campaign: { campaignName: "Penjualan - Uji", objective: "sales", dailyBudget: 50000, pageId: "1", primaryText: "Teks utama iklan", headline: "Judul", adName: "Iklan 1" },
  };
  it("default: langsung tayang setelah disetujui, CTA Meta LEARN_MORE", () => {
    const r = videoAdInput.parse(ok);
    expect(r.campaign.startNow).toBe(true);
    expect(r.campaign.metaCta).toBe("LEARN_MORE");
  });
  it("menolak naskah terlalu pendek, tanpa visual, dan tujuan tidak dikenal", () => {
    expect(videoAdInput.safeParse({ ...ok, script: "Pendek." }).success).toBe(false);
    expect(videoAdInput.safeParse({ ...ok, mediaIds: [] }).success).toBe(false);
    expect(videoAdInput.safeParse({ ...ok, campaign: { ...ok.campaign, objective: "awareness" } }).success).toBe(false);
  });
});
