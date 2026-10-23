import { describe, expect, it } from "vitest";
import { activeWord, groupWords, normalizeWords, pageAt, wordsFromAlignment } from "../src/captions";

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe("wordsFromAlignment (cap waktu karakter ElevenLabs → kata)", () => {
  it("memisah kata di spasi dan memakai awal huruf pertama & akhir huruf terakhir", () => {
    const chars = "Halo dunia".split("");
    const starts = chars.map((_, i) => i * 0.1), ends = chars.map((_, i) => i * 0.1 + 0.1);
    expect(wordsFromAlignment({ characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends })).toEqual([
      { text: "Halo", start: 0, end: 0.4 }, { text: "dunia", start: 0.5, end: 1 },
    ]);
  });
  it("spasi ganda, baris baru, dan spasi di ujung tidak menghasilkan kata kosong", () => {
    const chars = " a  b\n".split(""), t = chars.map((_, i) => i);
    const r = wordsFromAlignment({ characters: chars, character_start_times_seconds: t, character_end_times_seconds: t.map((x) => x + 1) });
    expect(r.map((x) => x.text)).toEqual(["a", "b"]);
  });
});

describe("normalizeWords", () => {
  it("urut, tidak tumpang tindih, dan minimal 80 ms per kata", () => {
    const r = normalizeWords([w("a", 0, 0.5), w("b", 0.3, 0.3), w("c", -1, 0)]);
    expect(r[1].start).toBeGreaterThanOrEqual(r[0].end);
    expect(r.every((x) => x.end - x.start >= 0.08 - 1e-9)).toBe(true);
    expect(r[2].start).toBeGreaterThanOrEqual(r[1].end);
  });
});

describe("groupWords", () => {
  const sentence = "Bikin video AI jadi cuma sepuluh menit. Tanpa ribet, cocok buat pemula.".split(" ")
    .map((t, i) => w(t, i * 0.4, i * 0.4 + 0.35));

  it("maksimal 4 kata & 22 karakter per halaman", () => {
    const pages = groupWords(sentence);
    expect(pages.every((p) => p.words.length <= 4 && p.words.map((x) => x.text).join(" ").length <= 22)).toBe(true);
    expect(pages.flatMap((p) => p.words.map((x) => x.text))).toEqual(sentence.map((x) => x.text)); // tidak ada kata hilang
  });
  it("memisah di akhir kalimat dan setelah koma (jika sudah ≥ 2 kata)", () => {
    const pages = groupWords(sentence);
    const texts = pages.map((p) => p.words.map((x) => x.text).join(" "));
    expect(texts.some((t) => t.endsWith("menit."))).toBe(true); // halaman berakhir di titik
    expect(texts.find((t) => t.startsWith("Tanpa"))).toBeDefined(); // kalimat baru mulai halaman baru
    expect(texts.some((t) => t.endsWith("ribet,"))).toBe(true);
  });
  it("memisah di jeda panjang antar kata", () => {
    const pages = groupWords([w("satu", 0, 0.3), w("dua", 0.35, 0.6), w("tiga", 2, 2.3)]);
    expect(pages.map((p) => p.words.length)).toEqual([2, 1]);
  });
  it("halaman tidak tumpang tindih dan tiap halaman menutupi kata-katanya", () => {
    const pages = groupWords(sentence);
    pages.forEach((p, i) => {
      expect(p.end).toBeGreaterThan(p.start);
      expect(p.end).toBeGreaterThanOrEqual(p.words[p.words.length - 1].end - 1e-9);
      if (pages[i + 1]) expect(p.end).toBeLessThanOrEqual(pages[i + 1].start + 1e-9);
    });
  });
  it("satu kata & input kosong aman", () => {
    expect(groupWords([w("halo", 0, 0.4)])).toHaveLength(1);
    expect(groupWords([])).toEqual([]);
  });
});

describe("pageAt & activeWord", () => {
  const pages = groupWords([w("satu", 0, 0.3), w("dua", 0.35, 0.6), w("tiga", 2, 2.3)]);
  it("halaman aktif sesuai waktu, kosong saat jeda", () => {
    expect(pageAt(pages, 0.1)?.words[0].text).toBe("satu");
    expect(pageAt(pages, 1.2)).toBeNull();
    expect(pageAt(pages, 2.1)?.words[0].text).toBe("tiga");
  });
  it("kata yang sedang diucapkan disorot", () => {
    expect(activeWord(pages[0], 0.1)).toBe(0);
    expect(activeWord(pages[0], 0.4)).toBe(1);
  });
});
