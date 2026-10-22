// Upload lampiran chat ke perpustakaan media akun iklan Meta (ads_creative_upload_media, sumber URL publik sementara).
// Foto langsung jadi image hash. Video diproses Meta beberapa menit: dipantau di latar belakang sampai siap,
// baru file sementaranya dihapus (Meta mengunduh URL secara asinkron, jadi file harus tetap ada sampai video siap).
import { metaMode } from "../env";
import { log, errMsg } from "../log";
import { dropFile, getMedia, publicUrl, setMeta, type MetaRef } from "../media";
import { callTool, conversationId, unwrap } from "./mcp";

const JOB = { job: "create_and_launch_new_ads" as const, request: "upload foto/video dari chat untuk iklan baru" };
const VIDEO_POLL_MS = 10_000, VIDEO_MAX_MS = 20 * 60_000;

/** Cari nilai string pertama untuk salah satu kunci, di objek bersarang (respons MCP kadang berisi string JSON). */
export function pick(obj: unknown, keys: string[], depth = 0): string | null {
  const o = unwrap(obj);
  if (!o || typeof o !== "object" || depth > 5) return null;
  for (const k of keys) {
    const v = (o as any)[k];
    if ((typeof v === "string" && v) || typeof v === "number") return String(v);
  }
  for (const v of Object.values(o as object)) {
    const found = pick(v, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Status pemrosesan video dari ads_get_ad_videos (string, atau objek {video_status, processing_progress}). */
export function parseVideoStatus(row: any): { status: "ready" | "processing" | "error"; progress: number | null } {
  const s = unwrap(row?.status);
  const raw = String(typeof s === "object" && s ? (s.video_status ?? s.status ?? "") : s ?? "").toLowerCase();
  const progress = typeof s === "object" && s?.processing_progress != null ? Number(s.processing_progress) : null;
  if (/ready|ok|complete/.test(raw)) return { status: "ready", progress: 100 };
  if (/error|fail/.test(raw)) return { status: "error", progress };
  return { status: "processing", progress };
}

/** Status video di akun iklan + thumbnail (dibutuhkan Meta untuk iklan video). */
export async function videoStatus(accountId: string, videoId: string) {
  const r = await callTool("ads_get_ad_videos", { ad_account_id: accountId, video_ids: [videoId], fields: ["id", "status", "picture", "length"] }, { conv: conversationId(), ...JOB });
  const rows: any[] = unwrap(r.videos ?? r.ad_videos ?? r.data) ?? [];
  const row = rows.find((v) => String(v.id) === videoId) ?? rows[0];
  if (!row) return { status: "processing" as const, progress: null, picture: null as string | null, length: null as number | null };
  return { ...parseVideoStatus(row), picture: (row.picture as string) || null, length: row.length != null ? Number(row.length) : null };
}

function watchVideo(mediaId: string, accountId: string, videoId: string, thumbnailHash?: string) {
  const started = Date.now();
  const tick = async () => {
    try {
      const v = await videoStatus(accountId, videoId);
      if (v.status === "ready" || v.status === "error") {
        setMeta(mediaId, { accountId, videoId, thumbnailHash, status: v.status, thumbnailUrl: v.picture ?? undefined, error: v.status === "error" ? "Meta gagal memproses video" : undefined });
        await dropFile(mediaId);
        log.info("video lampiran selesai diproses Meta", { mediaId, videoId, status: v.status });
        return;
      }
    } catch (e) { log.warn("cek status video gagal", { mediaId, error: errMsg(e) }); }
    if (Date.now() - started < VIDEO_MAX_MS) setTimeout(tick, VIDEO_POLL_MS).unref();
    else { setMeta(mediaId, { accountId, videoId, thumbnailHash, status: "error", error: "Video tidak selesai diproses Meta dalam 20 menit" }); await dropFile(mediaId); }
  };
  setTimeout(tick, VIDEO_POLL_MS).unref();
}

/**
 * Upload satu lampiran ke akun iklan. Dipanggil lagi untuk lampiran yang sama → kembalikan status terbaru tanpa upload ulang.
 */
export async function uploadAttachment(mediaId: string, userId: number, accountId: string): Promise<MetaRef & { kind: "image" | "video"; name: string; note: string }> {
  const e = getMedia(mediaId, userId);
  if (!e) throw new Error("Lampiran tidak ditemukan atau sudah kedaluwarsa (2 jam). Minta user upload ulang.");
  const base = { kind: e.kind, name: e.name };
  if (e.meta && e.meta.accountId === accountId) {
    if (e.meta.videoId && e.meta.status === "processing") {
      const v = await videoStatus(accountId, e.meta.videoId);
      if (v.status !== "processing") { setMeta(e.id, { ...e.meta, status: v.status, thumbnailUrl: v.picture ?? undefined }); await dropFile(e.id); }
      return { ...e.meta, ...base, status: v.status, thumbnailUrl: v.picture ?? undefined, note: v.status === "processing" ? `Video masih diproses Meta${v.progress != null ? ` (${v.progress}%)` : ""}.` : "Video siap dipakai." };
    }
    return { ...e.meta, ...base, note: "Sudah diupload ke akun ini sebelumnya." };
  }
  if (e.meta) throw new Error(`Lampiran ini sudah diupload ke akun ${e.meta.accountId}. Untuk akun lain, minta user upload ulang file-nya.`);
  if (!e.file) throw new Error("File sementara sudah dihapus. Minta user upload ulang.");
  if (metaMode() !== "mcp") throw new Error("Upload media butuh jalur MCP Meta.");

  if (e.kind === "image") {
    const imageHash = await uploadImage(e, accountId);
    const meta: MetaRef = { accountId, status: "ready", imageHash };
    setMeta(e.id, meta);
    await dropFile(e.id);
    return { ...meta, ...base, note: "Foto sudah di perpustakaan media akun iklan; file sementara dihapus. Pakai imageHash di propose_launch." };
  }
  // Cover resolusi penuh dari browser (kalau ada) jadi thumbnail iklan; thumbnail Meta hanya 160px.
  let thumbnailHash: string | undefined;
  const cover = e.coverId ? getMedia(e.coverId, userId) : null;
  if (cover?.file) {
    try { thumbnailHash = await uploadImage(cover, accountId); setMeta(cover.id, { accountId, status: "ready", imageHash: thumbnailHash }); }
    catch (err) { log.warn("cover video gagal diupload, pakai thumbnail Meta", { mediaId: e.id, error: errMsg(err) }); }
    await dropFile(cover.id);
  }
  const r = await callTool("ads_creative_upload_media", {
    ad_account_id: accountId, upload_source: "URL", media_type: "VIDEO", media_url: publicUrl(e), name: e.name.replace(/\.[^.]+$/, ""),
  }, { conv: conversationId(), ...JOB });
  const videoId = pick(r, ["video_id", "id"]);
  if (!videoId) throw new Error("Meta tidak mengembalikan video ID: " + JSON.stringify(r).slice(0, 300));
  const meta: MetaRef = { accountId, status: "processing", videoId, thumbnailHash };
  setMeta(e.id, meta);
  watchVideo(e.id, accountId, videoId, thumbnailHash);
  return {
    ...meta, ...base,
    note: "Video diterima Meta dan sedang diproses (biasanya 1–5 menit). Kartu rencana boleh dibuat sekarang; eksekusi menunggu video siap. " +
      (thumbnailHash ? "Di propose_launch isi creative.videoId DAN creative.imageHash = thumbnailHash (cover video). " : "Thumbnail diambil otomatis dari Meta. ") +
      "File sementara dihapus otomatis begitu video siap.",
  };
}

async function uploadImage(e: Parameters<typeof publicUrl>[0], accountId: string) {
  const r = await callTool("ads_creative_upload_media", {
    ad_account_id: accountId, upload_source: "URL", media_type: "IMAGE", media_url: publicUrl(e), name: e.name.replace(/\.[^.]+$/, ""),
  }, { conv: conversationId(), ...JOB });
  const hash = pick(r, ["image_hash", "hash"]);
  if (!hash) throw new Error("Meta tidak mengembalikan image hash: " + JSON.stringify(r).slice(0, 300));
  return hash;
}
