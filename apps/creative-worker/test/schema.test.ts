import { describe, expect, it } from "vitest";
import { END_CARD_SEC, adProps } from "../src/schema";

const ok = {
  hook: "Bikin timelapse pakai AI", cta: "Klik link di bawah", durationSec: 20,
  words: [{ text: "halo", start: 0, end: 0.4 }],
  scenes: [{ kind: "image", src: "http://127.0.0.1:1/a.jpg" }],
  brand: { name: "Brand", primary: "#1f3a8a", accent: "#facc15" },
};

describe("kontrak props video iklan", () => {
  it("props minimal valid dan nilai bawaan terisi", () => {
    const p = adProps.parse(ok);
    expect(p.bullets).toEqual([]);
    expect(p.scenes[0].weight).toBe(1);
  });
  it("menolak warna bukan #RRGGBB, durasi di luar 5–60 dtk, dan kata kosong", () => {
    expect(adProps.safeParse({ ...ok, brand: { ...ok.brand, accent: "yellow" } }).success).toBe(false);
    expect(adProps.safeParse({ ...ok, durationSec: 4 }).success).toBe(false);
    expect(adProps.safeParse({ ...ok, durationSec: 61 }).success).toBe(false);
    expect(adProps.safeParse({ ...ok, words: [] }).success).toBe(false);
  });
  it("membatasi panjang teks supaya tidak meluber di layar", () => {
    expect(adProps.safeParse({ ...ok, hook: "x".repeat(81) }).success).toBe(false);
    expect(adProps.safeParse({ ...ok, bullets: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(adProps.safeParse({ ...ok, scenes: [] }).success).toBe(false);
  });
  it("kartu penutup 2,2 dtk", () => expect(END_CARD_SEC).toBe(2.2));
});

describe("pickConcurrency", () => {
  it("dibatasi jumlah core yang terlihat (container --cpus=1.5 terbaca 1 core)", async () => {
    const { pickConcurrency } = await import("../src/render");
    expect(pickConcurrency(2, 1)).toBe(1);
    expect(pickConcurrency(2, 4)).toBe(2);
    expect(pickConcurrency(0, 4)).toBe(1);
    expect(pickConcurrency(Number.NaN, 4)).toBe(1);
  });
});
