import { describe, expect, it } from "vitest";
import { presetRange, shiftRange, compareRange, lenDays, clampRange, fmtRange, todayKey, isDateKey } from "./dates";
import { parseRp, rpk, rp } from "./money";
import { computeKpis, delta } from "./metrics";
import { recFor, DEFAULT_SETTINGS } from "./rules";
import { parseIntent } from "./intent";

describe("dates", () => {
  const T = "2026-10-19"; // Senin
  it("preset", () => {
    expect(presetRange("today", T)).toEqual([T, T]);
    expect(presetRange("yesterday", T)).toEqual(["2026-10-18", "2026-10-18"]);
    expect(presetRange("7d", T)).toEqual(["2026-10-13", T]);
    expect(presetRange("thisweek", T)).toEqual([T, T]);
    expect(presetRange("lastweek", T)).toEqual(["2026-10-12", "2026-10-18"]);
    expect(presetRange("thisweek", "2026-10-25")).toEqual(["2026-10-19", "2026-10-25"]); // Minggu
    expect(presetRange("30d", T)).toEqual(["2026-09-20", T]);
    expect(presetRange("thismonth", T)).toEqual(["2026-10-01", T]);
    expect(presetRange("lastmonth", T)).toEqual(["2026-09-01", "2026-09-30"]);
    expect(presetRange("lastmonth", "2026-01-05")).toEqual(["2025-12-01", "2025-12-31"]);
    expect(lenDays(...presetRange("90d", T))).toBe(90);
  });
  it("shift bulan kalender", () => {
    expect(shiftRange("2026-09-01", "2026-09-30", -1, T)).toEqual(["2026-08-01", "2026-08-31"]);
    expect(shiftRange("2026-09-01", "2026-09-30", 1, T)).toEqual(["2026-10-01", T]);
    expect(shiftRange("2024-03-01", "2024-03-31", -1, T)).toEqual(["2024-02-01", "2024-02-29"]);
    expect(shiftRange("2026-10-13", T, -1, T)).toEqual(["2026-10-06", "2026-10-12"]);
  });
  it("pembanding", () => {
    expect(compareRange("2026-10-01", "2026-10-19")).toEqual(["2026-09-01", "2026-09-19"]);
    expect(compareRange("2026-03-01", "2026-03-31")).toEqual(["2026-02-01", "2026-02-28"]);
    expect(compareRange("2026-10-13", T)).toEqual(["2026-10-06", "2026-10-12"]);
    expect(compareRange(T, T)).toEqual(["2026-10-18", "2026-10-18"]);
  });
  it("clamp & format", () => {
    expect(clampRange("2026-10-25", "2026-10-10", T)).toEqual(["2026-10-10", T]);
    expect(fmtRange("2026-10-01", "2026-10-19")).toBe("1–19 Okt 2026");
    expect(fmtRange("2025-12-20", "2026-01-05")).toBe("20 Des 2025 – 5 Jan 2026");
    expect(todayKey(new Date("2026-10-18T18:30:00Z"))).toBe("2026-10-19"); // 01:30 WIB
    expect(isDateKey("2026-02-30")).toBe(false);
  });
});

describe("money", () => {
  it("parseRp", () => {
    expect(parseRp("7.500.000")).toBe(7_500_000);
    expect(parseRp("7,5jt")).toBe(7_500_000);
    expect(parseRp("750rb")).toBe(750_000);
    expect(parseRp("500k")).toBe(500_000);
    expect(parseRp("Rp 1.250.000")).toBe(1_250_000);
    expect(parseRp("25 juta")).toBe(25_000_000);
    expect(parseRp("1,2 miliar")).toBe(1_200_000_000);
    expect(parseRp("")).toBe(0);
    expect(parseRp("abc")).toBe(0);
  });
  it("format", () => {
    expect(rp(1234567)).toBe("Rp1.234.567");
    expect(rpk(1_250_000)).toBe("Rp1,25 jt");
    expect(rpk(450_000)).toBe("Rp450 rb");
    expect(rpk(Infinity)).toBe("—");
  });
});

describe("metrics", () => {
  const base = {
    days: 30,
    lines: ["digital", "jasa"] as ("digital" | "jasa")[],
    ads: [
      { accountId: "d", line: "digital" as const, spend: 1_000_000, impr: 100_000, clicks: 1_500, leads: 0, purchases: 30, metaRev: 3_500_000, adTaxPct: 11 },
      { accountId: "j", line: "jasa" as const, spend: 500_000, impr: 50_000, clicks: 500, leads: 20, purchases: 0, metaRev: 0, adTaxPct: 11 },
    ],
    sales: [
      { line: "digital" as const, revenue: 3_000_000, orders: 25, cogs: 0 },
      { line: "jasa" as const, revenue: 7_500_000, orders: 1, cogs: 2_500_000 },
    ],
    costs: [
      { line: "digital" as const, feePct: 0, fixed: 720_000, other: 149_000 },
      { line: "jasa" as const, feePct: 0, fixed: 2_900_000, other: 1_500_000 },
    ],
  };
  it("laba bersih gabungan", () => {
    const k = computeKpis(base);
    expect(k.revenue).toBe(10_500_000);
    expect(k.adTax).toBeCloseTo(165_000);
    expect(k.gross).toBe(8_000_000);
    expect(k.fixed).toBe(3_620_000);
    expect(k.net).toBeCloseTo(8_000_000 - 1_500_000 - 165_000 - 3_620_000 - 1_649_000);
    expect(k.closeRate).toBe(0.05);
    expect(k.cpl).toBe(25_000);
  });
  it("PPN lynk 3% dihitung dari omzet kotor (feeBase), bukan grandTotal", () => {
    const k = computeKpis({
      days: 30, lines: ["digital"],
      ads: [{ accountId: "d", line: "digital", spend: 1_000_000, impr: 0, clicks: 0, leads: 0, purchases: 0, metaRev: 0, adTaxPct: 3 }],
      sales: [{ line: "digital", revenue: 97_000, orders: 1, cogs: 0, feeBase: 100_000 }], // grandTotal 97rb, kotor 100rb
      costs: [{ line: "digital", feePct: 3, fixed: 0, other: 0 }],
    });
    expect(k.fee).toBe(3_000);
    expect(k.adTax).toBe(30_000);
    expect(k.gross).toBe(94_000);
  });
  it("filter lini", () => {
    const k = computeKpis({ ...base, lines: ["digital"] });
    expect(k.revenue).toBe(3_000_000);
    expect(k.spend).toBe(1_000_000);
    expect(k.roas).toBe(3);
  });
  it("tanpa data → nol, bukan NaN", () => {
    const k = computeKpis({ days: 1, lines: ["digital"], ads: [], sales: [], costs: [] });
    expect(k.roas).toBe(0);
    expect(k.netMargin).toBe(0);
    expect(Number.isNaN(k.beRoas)).toBe(false);
  });
  it("delta", () => {
    expect(delta(120, 100)).toBeCloseTo(0.2);
    expect(delta(5, 0)).toBeNull();
    expect(delta(-50, -100)).toBeCloseTo(0.5);
  });
});

describe("rules", () => {
  const D = DEFAULT_SETTINGS.digital, J = DEFAULT_SETTINGS.jasa;
  it("digital", () => {
    expect(recFor({ status: "PAUSED", spend: 1, purchases: 0, leads: 0, revenue: 0 }, "digital", D).code).toBe("inactive");
    expect(recFor({ status: "ACTIVE", spend: 200_000, purchases: 2, leads: 0, revenue: 200_000 }, "digital", D).code).toBe("kill");
    expect(recFor({ status: "ACTIVE", spend: 100_000, purchases: 5, leads: 0, revenue: 400_000 }, "digital", D).code).toBe("scale");
    expect(recFor({ status: "ACTIVE", spend: 50_000, purchases: 2, leads: 0, revenue: 100_000 }, "digital", D).code).toBe("creative");
    expect(recFor({ status: "ACTIVE", spend: 100_000, purchases: 3, leads: 0, revenue: 280_000 }, "digital", D).code).toBe("keep");
  });
  it("jasa", () => {
    expect(recFor({ status: "ACTIVE", spend: 400_000, purchases: 0, leads: 4, revenue: 0 }, "jasa", J).code).toBe("kill");
    expect(recFor({ status: "ACTIVE", spend: 100_000, purchases: 0, leads: 1, revenue: 0 }, "jasa", J).code).toBe("creative");
    expect(recFor({ status: "ACTIVE", spend: 100_000, purchases: 0, leads: 3, revenue: 0 }, "jasa", J).code).toBe("keep");
  });
  it("belum ganti kreatif sebelum spend seharga satu hasil (batas CPL/CPA)", () => {
    // Kasus nyata akun -03: kampanye baru Rp12, 0 lead → bukan "Ganti kreatif".
    expect(recFor({ status: "ACTIVE", spend: 12, purchases: 0, leads: 0, revenue: 0 }, "jasa", J)).toEqual({ code: "keep", label: "Kumpulkan data", tone: "neutral" });
    expect(recFor({ status: "ACTIVE", spend: 59_999, purchases: 0, leads: 0, revenue: 0 }, "jasa", J).label).toBe("Kumpulkan data");
    expect(recFor({ status: "ACTIVE", spend: 60_000, purchases: 0, leads: 0, revenue: 0 }, "jasa", J).code).toBe("creative");
    expect(recFor({ status: "ACTIVE", spend: 30_000, purchases: 0, leads: 0, revenue: 0 }, "digital", D).label).toBe("Kumpulkan data");
    expect(recFor({ status: "ACTIVE", spend: 45_000, purchases: 0, leads: 0, revenue: 0 }, "digital", D).code).toBe("creative");
    // Tanpa batas CPA: patokan setengah batas "matikan setelah spend".
    expect(recFor({ status: "ACTIVE", spend: 40_000, purchases: 0, leads: 0, revenue: 0 }, "digital", { ...D, maxCpa: null }).label).toBe("Kumpulkan data");
    expect(recFor({ status: "ACTIVE", spend: 50_000, purchases: 0, leads: 0, revenue: 0 }, "digital", { ...D, maxCpa: null }).code).toBe("creative");
  });
});

describe("intent", () => {
  const accs = [{ id: "111", name: "Adv Digital", line: "digital" as const }, { id: "222", name: "Adv Jasa", line: "jasa" as const }];
  it("pindah tampilan saja", () => {
    expect(parseIntent("akun jasa", accs)).toMatchObject({ acc: "jasa", hasQuestion: false });
    expect(parseIntent("semua akun bulan lalu", accs)).toMatchObject({ acc: "all", preset: "lastmonth", hasQuestion: false });
  });
  it("pertanyaan + konteks", () => {
    expect(parseIntent("roas digital minggu ini", accs)).toMatchObject({ acc: "digital", preset: "thisweek", hasQuestion: true });
    expect(parseIntent("laba bulan lalu", accs)).toMatchObject({ preset: "lastmonth", hasQuestion: true });
    expect(parseIntent("jam paling cuan", accs).hasQuestion).toBe(true);
  });
  it("aturan", () => {
    expect(parseIntent("target roas 3", accs).rule).toEqual({ field: "targetRoas", value: 3 });
    expect(parseIntent("batas cpa 40rb", accs).rule).toEqual({ field: "maxCpa", value: 40_000 });
    expect(parseIntent("batas cpl jadi 55rb", accs).rule).toEqual({ field: "maxCpl", value: 55_000 });
  });
  it("aksi & konfirmasi", () => {
    expect(parseIntent("pause test kreatif", accs).campaignAction).toBe("pause");
    expect(parseIntent("scale bundle", accs).campaignAction).toBe("scale");
    expect(parseIntent("ya", accs).confirm).toBe("yes");
    expect(parseIntent("batal", accs).confirm).toBe("no");
  });
});
