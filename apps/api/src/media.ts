// Lampiran foto/video chat. Disimpan SEMENTARA di disk (bukan database), disajikan lewat link publik acak supaya Meta
// bisa mengunduhnya (ads_creative_upload_media sumber URL), lalu dihapus begitu Meta menerimanya atau setelah 2 jam.
// Daftar lampiran hanya di memori: restart server = semua file sementara dibuang.
import { createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ChatAttachment } from "@iklan/shared";
import { env } from "./env";
import { log } from "./log";

/** Batas Meta untuk upload media iklan. */
export const MEDIA_LIMITS = { image: 30 * 1024 * 1024, video: 100 * 1024 * 1024 } as const;
const TTL_MS = 2 * 3600_000;
const MAX_PER_USER = 10; // termasuk cover video otomatis
const DIR = env.MEDIA_DIR || path.join(tmpdir(), "iklan-media");

export class MediaError extends Error {
  constructor(message: string, public status: 400 | 404 | 413 | 415 | 429 = 400) { super(message); }
}

/** Status media di Meta setelah diupload ke perpustakaan akun iklan. */
export interface MetaRef {
  accountId: string; status: "processing" | "ready" | "error";
  imageHash?: string; videoId?: string; thumbnailUrl?: string; thumbnailHash?: string; error?: string;
}
/** `coverId` = frame resolusi penuh yang diambil browser dari video ini, dipakai sebagai cover iklan video. */
interface Entry extends ChatAttachment { token: string; file: string | null; userId: number; sha256: string; expiresAt: number; meta?: MetaRef; coverId?: string }

const store = new Map<string, Entry>();

/** Kenali jenis file dari byte awalnya (nama & Content-Type dari browser bisa keliru). */
export function sniff(head: Buffer): { kind: "image" | "video"; mime: string } | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "image", mime: "image/jpeg" };
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", mime: "image/png" };
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") {
    return { kind: "video", mime: head.toString("latin1", 8, 12) === "qt  " ? "video/quicktime" : "video/mp4" };
  }
  return null;
}

const EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "video/mp4": ".mp4", "video/quicktime": ".mov" };

/** Nama tampilan yang aman: tanpa folder, tanpa karakter kontrol, ekstensi sesuai isi file. */
export function safeName(raw: string, mime: string) {
  const base = path.basename(raw.replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f"<>]/g, "").trim() || "lampiran";
  const stem = base.replace(/\.[^.]{1,5}$/, "").slice(0, 100) || "lampiran";
  return stem + (EXT[mime] ?? "");
}

let started = false;
function ensureDir() {
  if (started) return;
  started = true;
  mkdirSync(DIR, { recursive: true });
  // Sisa proses sebelumnya tidak tercatat di memori lagi, jadi dibuang.
  for (const f of readdirSync(DIR)) rmSync(path.join(DIR, f), { force: true });
  setInterval(sweep, 5 * 60_000).unref();
}

/** Simpan body upload ke disk sambil dialirkan (tidak ditampung di RAM), cek jenis & ukuran, hitung SHA-256. */
export async function saveMedia(body: ReadableStream<Uint8Array> | null, opts: { name: string; userId: number; coverFor?: string; ttlMs?: number }): Promise<ChatAttachment> {
  if (!body) throw new MediaError("File kosong");
  ensureDir();
  const video = opts.coverFor ? getMedia(opts.coverFor, opts.userId) : null;
  if (opts.coverFor && (!video || video.kind !== "video" || video.meta)) throw new MediaError("Video untuk cover ini tidak ditemukan", 404);
  const mine = [...store.values()].filter((e) => e.userId === opts.userId && e.file);
  if (mine.length >= MAX_PER_USER) throw new MediaError(`Maksimal ${MAX_PER_USER} lampiran aktif. Hapus atau pakai yang ada dulu.`, 429);

  const id = "m_" + randomBytes(9).toString("base64url");
  const file = path.join(DIR, id);
  const hash = createHash("sha256");
  let head = Buffer.alloc(0), type: ReturnType<typeof sniff> = null, size = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!type) {
        head = Buffer.concat([head, chunk]).subarray(0, 16);
        if (head.length >= 12) {
          type = sniff(head);
          if (!type) return cb(new MediaError("Format tidak didukung. Pakai foto JPG/PNG atau video MP4/MOV.", 415));
        }
      }
      size += chunk.length;
      if (size > (type ? MEDIA_LIMITS[type.kind] : MEDIA_LIMITS.video)) {
        return cb(new MediaError(`File terlalu besar. Maksimal foto ${MEDIA_LIMITS.image / 1048576} MB, video ${MEDIA_LIMITS.video / 1048576} MB.`, 413));
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body as any), check, createWriteStream(file, { flags: "wx", mode: 0o600 }));
    if (!type || size === 0) throw new MediaError("File terlalu kecil atau formatnya tidak dikenali.", 415);
  } catch (e) {
    await rm(file, { force: true });
    throw e instanceof MediaError ? e : new MediaError("Upload terputus, coba lagi.");
  }
  const t = type as NonNullable<ReturnType<typeof sniff>>;
  if (video && t.kind !== "image") { await rm(file, { force: true }); throw new MediaError("Cover video harus berupa foto", 415); }
  const entry: Entry = {
    id, kind: t.kind, mime: t.mime, name: safeName(opts.name, t.mime), size, file, userId: opts.userId,
    sha256: hash.digest("hex"), token: randomBytes(24).toString("base64url"), expiresAt: Date.now() + (opts.ttlMs ?? TTL_MS),
  };
  store.set(id, entry);
  if (video) {
    if (video.coverId) await removeEntry(video.coverId);
    video.coverId = id;
  }
  log.info("lampiran chat disimpan sementara", { id, kind: entry.kind, size, coverFor: video?.id });
  return publicInfo(entry);
}

const publicInfo = (e: Entry): ChatAttachment => ({ id: e.id, kind: e.kind, name: e.name, size: e.size, mime: e.mime });

/** Lampiran milik user ini (masih berlaku). */
export function getMedia(id: string, userId: number) {
  const e = store.get(id);
  return e && e.userId === userId && e.expiresAt > Date.now() ? e : null;
}
export const attachmentOf = (e: Entry) => publicInfo(e);

/** Isi file lampiran milik user (untuk dikirim ke worker render atau diputar di kartu pratinjau); null kalau sudah dihapus. */
export function readMedia(id: string, userId: number) {
  const e = getMedia(id, userId);
  return e?.file ? { entry: e, stream: (range?: { start: number; end: number }) => createReadStream(e.file!, range) } : null;
}

const VISION_RAW_MAX = Math.floor(3.7 * 1024 * 1024); // ≤ 5 MB setelah base64 (batas blok gambar Claude)

/** Ambil pratinjau visual (foto asli atau cover frame video) dalam base64 untuk diinspeksi AI vision. */
export async function readMediaVision(id: string, userId: number): Promise<{
  info: ChatAttachment;
  source: "image" | "video_cover" | "none";
  mimeType?: "image/jpeg" | "image/png";
  data?: string;
  note?: string;
} | null> {
  const e = getMedia(id, userId);
  if (!e) return null;
  const info = publicInfo(e);
  const target = e.kind === "image" ? e : (e.coverId ? getMedia(e.coverId, userId) : null);
  if (!target?.file) {
    return {
      info,
      source: "none",
      note: e.kind === "video"
        ? "Cover frame video belum tersedia atau file sementara sudah dihapus setelah upload ke Meta."
        : "File sementara sudah dihapus setelah diupload ke Meta; panggil inspect_media SEBELUM upload_media_to_meta.",
    };
  }
  if (target.size > VISION_RAW_MAX) {
    return {
      info,
      source: "none",
      note: `Ukuran gambar ${(target.size / 1048576).toFixed(1)} MB melebihi batas pratinjau vision (3,7 MB), tetapi tetap siap diupload ke Meta.`,
    };
  }
  const buf = await readFile(target.file);
  return {
    info,
    source: e.kind === "image" ? "image" : "video_cover",
    mimeType: target.mime === "image/png" ? "image/png" : "image/jpeg",
    data: buf.toString("base64"),
  };
}

/** URL publik sementara yang diunduh Meta. Ekstensi di akhir membantu Meta mengenali jenis file. */
export const publicUrl = (e: Entry) => `${env.APP_URL.replace(/\/$/, "")}/m/${e.token}/${encodeURIComponent(e.name)}`;

/** Buka file untuk diunduh lewat link publik; null kalau token salah, sudah dihapus, atau kedaluwarsa. */
export function openByToken(token: string) {
  for (const e of store.values()) {
    if (e.token === token && e.file && e.expiresAt > Date.now()) {
      return { entry: e, stream: () => createReadStream(e.file!) };
    }
  }
  return null;
}

export function setMeta(id: string, meta: MetaRef) {
  const e = store.get(id);
  if (e) e.meta = meta;
}

/** Hapus file dari disk (Meta sudah punya salinannya). Catatan media_id → hash/video tetap ada sampai kedaluwarsa. */
export async function dropFile(id: string) {
  const e = store.get(id);
  if (!e?.file) return;
  const f = e.file;
  e.file = null;
  await rm(f, { force: true });
  log.info("file lampiran dihapus", { id, meta: e.meta?.status });
}

async function removeEntry(id: string) {
  const e = store.get(id);
  if (!e) return;
  await dropFile(id);
  store.delete(id);
  if (e.coverId) await removeEntry(e.coverId);
}

/** User membatalkan lampiran (cover videonya ikut dihapus). */
export async function removeMedia(id: string, userId: number) {
  if (!getMedia(id, userId)) throw new MediaError("Lampiran tidak ditemukan", 404);
  await removeEntry(id);
}

export async function sweep(now = Date.now()) {
  for (const e of [...store.values()]) if (e.expiresAt <= now) await removeEntry(e.id);
}

/** Untuk tes & pemantauan. */
export const mediaDir = () => DIR;
export const mediaCount = () => ({ entries: store.size, files: [...store.values()].filter((e) => e.file).length });
