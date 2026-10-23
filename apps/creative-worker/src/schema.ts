// Kontrak antara pembuat naskah (API dashboard) dan template Remotion. Semua teks yang tampil di video datang dari sini,
// jadi harga/produk/CTA berasal dari data dashboard, bukan dikarang model video.
import { z } from "zod";

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;
/** Kartu penutup (CTA + harga) di akhir video. */
export const END_CARD_SEC = 2.2;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Warna harus #RRGGBB");

export const wordSchema = z.object({ text: z.string().min(1).max(40), start: z.number().min(0), end: z.number().min(0) });

export const adProps = z.object({
  hook: z.string().trim().min(2).max(80),
  bullets: z.array(z.string().trim().min(1).max(60)).max(3).default([]),
  /** Mis. "Rp49rb". Dari data produk dashboard. */
  priceBadge: z.string().trim().max(20).optional(),
  cta: z.string().trim().min(2).max(60),
  ctaSub: z.string().trim().max(80).optional(),
  /** Kata + cap waktu (detik) dari suara. Sumber subtitle. */
  words: z.array(wordSchema).min(1).max(160),
  audioSrc: z.string().optional(),
  /** Panjang total termasuk kartu penutup. */
  durationSec: z.number().min(5).max(60),
  scenes: z.array(z.object({
    kind: z.enum(["image", "video"]),
    src: z.string().min(1),
    /** Bobot durasi relatif antar adegan. */
    weight: z.number().positive().default(1),
  })).min(1).max(8),
  logoSrc: z.string().optional(),
  brand: z.object({ name: z.string().trim().min(1).max(40), primary: hex, accent: hex }),
});

export type AdProps = z.infer<typeof adProps>;
export type Word = z.infer<typeof wordSchema>;
