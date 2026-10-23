import { describe, expect, it } from "vitest";
import { estimateWords } from "../src/captions";
import { ASSET_NAME, jobSpec } from "../src/jobs";

describe("estimateWords (subtitle tanpa suara)", () => {
  it("urut, tanpa tumpang tindih, jeda lebih panjang di akhir kalimat", () => {
    const w = estimateWords("Halo semua. Ini video, singkat!");
    expect(w.map((x) => x.text)).toEqual(["Halo", "semua.", "Ini", "video,", "singkat!"]);
    w.slice(1).forEach((x, i) => expect(x.start).toBeGreaterThan(w[i].end));
    expect(w[2].start - w[1].end).toBeGreaterThan(w[1].start - w[0].end);
  });
  it("naskah 60 kata ≈ 20–30 detik (tempo iklan)", () => {
    const w = estimateWords(Array.from({ length: 60 }, (_, i) => (i % 9 === 8 ? "kalimat." : "kata")).join(" "));
    expect(w.at(-1)!.end).toBeGreaterThan(18);
    expect(w.at(-1)!.end).toBeLessThan(32);
  });
});

describe("jobSpec", () => {
  const ok = {
    hook: "Hook", cta: "Klik", script: "Naskah yang cukup panjang.", brand: { name: "Brand", primary: "#112233", accent: "#ffcc00" },
    scenes: [{ asset: "s1.jpg", kind: "image" }],
  };
  it("menerima spec minimal", () => expect(jobSpec.safeParse(ok).success).toBe(true));
  it("nama aset dibatasi (anti path traversal)", () => {
    expect(ASSET_NAME.test("../etc/passwd")).toBe(false);
    expect(ASSET_NAME.test("s1.exe")).toBe(false);
    expect(jobSpec.safeParse({ ...ok, scenes: [{ asset: "../x.jpg", kind: "image" }] }).success).toBe(false);
  });
  it("menolak warna bukan #RRGGBB dan lebih dari 8 adegan", () => {
    expect(jobSpec.safeParse({ ...ok, brand: { ...ok.brand, primary: "red" } }).success).toBe(false);
    expect(jobSpec.safeParse({ ...ok, scenes: Array.from({ length: 9 }, () => ok.scenes[0]) }).success).toBe(false);
  });
});
