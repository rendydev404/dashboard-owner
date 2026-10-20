import { describe, expect, it } from "vitest";
import { lynkSignature, verifySignature, splitRevenue, lynkDate, rawGrandTotal } from "../src/lynk";

describe("lynk webhook helpers", () => {
  it("signature sesuai dokumentasi (grandTotal + refId + message_id + key)", () => {
    const sig = lynkSignature("72000", "13f8d23beeb2aacbbc01c94060cc88d7", "API_CALL_1744270275143115_4624014", "kunci");
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
    expect(verifySignature(sig, sig)).toBe(true);
    expect(verifySignature(sig.toUpperCase(), sig)).toBe(true);
    expect(verifySignature("salah", sig)).toBe(false);
    expect(verifySignature(undefined, sig)).toBe(false);
  });
  it("grandTotal diambil persis dari JSON mentah", () => {
    expect(rawGrandTotal('{"totals":{"grandTotal": 72000}}', 72000)).toBe("72000");
    expect(rawGrandTotal('{"totals":{"grandTotal":"72000.50"}}', "72000.50")).toBe("72000.50");
  });
  it("pembagian omzet per item selalu = grandTotal", () => {
    const items = [{ price: 149000, qty: 1 }, { price: 49000, qty: 2, addons: [{ price: "10,000" }] }];
    const out = splitRevenue(items, 250000);
    expect(out.reduce((a, b) => a + b, 0)).toBe(250000);
    expect(out[0]).toBeGreaterThan(out[1] / 2);
    expect(splitRevenue([{ price: 0 }, { price: 0 }], 101)).toEqual([50, 51]);
  });
  it("createdAt tanpa zona dianggap WIB", () => {
    expect(lynkDate("2026-10-19T01:30:00")).toEqual({ date: "2026-10-19", at: "2026-10-18T18:30:00.000Z" });
    expect(lynkDate("2026-10-18T20:00:00Z").date).toBe("2026-10-19");
  });
});
