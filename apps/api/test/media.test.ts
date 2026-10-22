import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MEDIA_DIR = mkdtempSync(path.join(tmpdir(), "media-test-"));

// MCP Meta tiruan: bentuk respons ads_get_ad_videos sama dengan respons asli (kunci ad_videos, status objek).
const calls: { tool: string; args: any }[] = [];
let videoReady = false;
vi.mock("../src/meta/mcp", () => ({
  conversationId: () => "conv-test",
  unwrap: (x: unknown) => (typeof x === "string" && /^\s*[\[{]/.test(x) ? JSON.parse(x) : x),
  callTool: vi.fn(async (tool: string, args: any) => {
    calls.push({ tool, args });
    if (tool === "ads_creative_upload_media") {
      return args.media_type === "IMAGE"
        ? { result_kind: "URL_IMAGE", images: JSON.stringify({ [args.name]: { hash: "hash-" + args.name, width: 1080 } }) }
        : { result_kind: "URL_VIDEO", video: { id: "v1", status: "processing" } };
    }
    if (tool === "ads_get_ad_videos") {
      return { ad_videos: [{ id: "v1", picture: "https://fbcdn/thumb160.jpg", status: { video_status: videoReady ? "ready" : "processing", processing_progress: videoReady ? 100 : 40 } }] };
    }
    return {};
  }),
}));
vi.mock("../src/env", async (orig) => ({ ...(await orig<typeof import("../src/env")>()), metaMode: () => "mcp" }));

const M = await import("../src/media");
const { uploadAttachment, pick, parseVideoStatus } = await import("../src/meta/upload");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(5000, 1)]);
const streamOf = (buf: Buffer, chunk = 700) => new ReadableStream<Uint8Array>({
  start(c) { for (let i = 0; i < buf.length; i += chunk) c.enqueue(new Uint8Array(buf.subarray(i, i + chunk))); c.close(); },
});
const files = () => readdirSync(M.mediaDir());
let user = 100;

beforeEach(() => { calls.length = 0; videoReady = false; user++; });

describe("penyimpanan sementara lampiran", () => {
  it("jenis dikenali dari byte awal, bukan nama file", () => {
    expect(M.sniff(JPEG)).toEqual({ kind: "image", mime: "image/jpeg" });
    expect(M.sniff(MP4)).toEqual({ kind: "video", mime: "video/mp4" });
    expect(M.sniff(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  ")]))).toEqual({ kind: "video", mime: "video/quicktime" });
    expect(M.sniff(Buffer.from("<html><body>bukan foto</body>"))).toBeNull();
  });

  it("disimpan ke disk lewat stream, disajikan lewat token publik, lalu bisa dihapus", async () => {
    const a = await M.saveMedia(streamOf(JPEG), { name: "../../etc/promo final.JPEG", userId: user });
    expect(a).toMatchObject({ kind: "image", mime: "image/jpeg", size: JPEG.length, name: "promo final.jpg" });
    const e = M.getMedia(a.id, user)!;
    expect(M.getMedia(a.id, user + 999)).toBeNull(); // milik user lain
    expect(M.publicUrl(e)).toMatch(/\/m\/[A-Za-z0-9_-]{32}\/promo%20final\.jpg$/);
    const f = M.openByToken(e.token)!;
    const got: Buffer[] = [];
    for await (const ch of f.stream()) got.push(ch as Buffer);
    expect(Buffer.concat(got).equals(JPEG)).toBe(true);
    await M.removeMedia(a.id, user);
    expect(M.openByToken(e.token)).toBeNull();
    expect(files()).not.toContain(a.id);
  });

  it("format salah & file terlalu besar ditolak tanpa meninggalkan file", async () => {
    await expect(M.saveMedia(streamOf(Buffer.from("GIF89a-bukan-yang-didukung")), { name: "x.gif", userId: user })).rejects.toMatchObject({ status: 415 });
    const big = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(JPEG.subarray(0, 16))); },
      pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); }, // terus mengalir sampai ditolak
    });
    await expect(M.saveMedia(big, { name: "besar.jpg", userId: user })).rejects.toMatchObject({ status: 413 });
    expect(files()).toEqual([]);
  });

  it("kedaluwarsa setelah 2 jam: file & catatan dibuang", async () => {
    const a = await M.saveMedia(streamOf(JPEG), { name: "a.jpg", userId: user });
    await M.sweep(Date.now() + 2 * 3600_000 + 1);
    expect(M.getMedia(a.id, user)).toBeNull();
    expect(files()).not.toContain(a.id);
  });
});

describe("upload ke Meta", () => {
  it("foto: jadi image hash lewat URL publik, file sementara langsung dihapus", async () => {
    const a = await M.saveMedia(streamOf(JPEG), { name: "promo.jpg", userId: user });
    const r = await uploadAttachment(a.id, user, "1434452684728861");
    expect(calls[0]).toMatchObject({ tool: "ads_creative_upload_media", args: { ad_account_id: "1434452684728861", upload_source: "URL", media_type: "IMAGE", name: "promo" } });
    expect(calls[0].args.media_url).toMatch(/\/m\/.+\/promo\.jpg$/);
    expect(r).toMatchObject({ status: "ready", imageHash: "hash-promo", kind: "image" });
    expect(files()).not.toContain(a.id);
    // Dipanggil lagi: tidak upload ulang.
    expect(await uploadAttachment(a.id, user, "1434452684728861")).toMatchObject({ imageHash: "hash-promo" });
    expect(calls).toHaveLength(1);
    await expect(uploadAttachment(a.id, user, "999")).rejects.toThrow(/akun lain/);
  });

  it("video + cover dari browser: cover jadi thumbnailHash, file video bertahan sampai Meta selesai memproses", async () => {
    const v = await M.saveMedia(streamOf(MP4), { name: "iklan.mp4", userId: user });
    const c = await M.saveMedia(streamOf(JPEG), { name: "iklan-cover.jpg", userId: user, coverFor: v.id });
    const r = await uploadAttachment(v.id, user, "1434452684728861");
    expect(calls.map((x) => x.args.media_type)).toEqual(["IMAGE", "VIDEO"]);
    expect(r).toMatchObject({ status: "processing", videoId: "v1", thumbnailHash: "hash-iklan-cover" });
    expect(files()).not.toContain(c.id); // cover sudah di Meta
    expect(files()).toContain(v.id); // Meta mengunduh video secara asinkron
    videoReady = true;
    expect(await uploadAttachment(v.id, user, "1434452684728861")).toMatchObject({ status: "ready", videoId: "v1", note: "Video siap dipakai." });
    expect(files()).not.toContain(v.id);
  });

  it("cover hanya untuk video milik user sendiri dan harus foto", async () => {
    const v = await M.saveMedia(streamOf(MP4), { name: "v.mp4", userId: user });
    await expect(M.saveMedia(streamOf(JPEG), { name: "c.jpg", userId: user + 1, coverFor: v.id })).rejects.toMatchObject({ status: 404 });
    await expect(M.saveMedia(streamOf(MP4), { name: "c.mp4", userId: user, coverFor: v.id })).rejects.toMatchObject({ status: 415 });
    await M.removeMedia(v.id, user);
  });

  it("parser respons Meta", () => {
    expect(pick({ images: JSON.stringify({ a: { hash: "h1" } }) }, ["image_hash", "hash"])).toBe("h1");
    expect(pick({ video_id: 123 }, ["video_id", "id"])).toBe("123");
    expect(parseVideoStatus({ status: { video_status: "ready" } }).status).toBe("ready");
    expect(parseVideoStatus({ status: { video_status: "processing", processing_progress: 40 } })).toEqual({ status: "processing", progress: 40 });
    expect(parseVideoStatus({ status: "error" }).status).toBe("error");
  });
});
