// Upload lampiran foto/video chat. Pakai XHR karena fetch belum punya progres upload.
import type { ChatAttachment } from "@iklan/shared";
import { ApiError } from "../lib/api";

export const ACCEPT = "image/jpeg,image/png,video/mp4,video/quicktime";
export const MAX_IMAGE = 30 * 1024 * 1024, MAX_VIDEO = 100 * 1024 * 1024;

/** Lampiran di kotak chat sebelum dikirim. `preview` = object URL lokal (tidak ikut dikirim ke server). */
export interface Pending { key: string; file: File; preview: string; progress: number; att?: ChatAttachment; error?: string; xhr?: XMLHttpRequest }

/** Cek cepat di browser sebelum upload (server tetap memeriksa isi file). */
export function precheck(f: File): string | null {
  const video = f.type.startsWith("video/");
  if (!ACCEPT.split(",").includes(f.type)) return "Format tidak didukung. Pakai foto JPG/PNG atau video MP4/MOV.";
  if (f.size > (video ? MAX_VIDEO : MAX_IMAGE)) return `Terlalu besar. Maksimal ${video ? "video 100" : "foto 30"} MB.`;
  return null;
}

export function uploadMedia(f: Blob & { name: string }, onProgress: (pct: number) => void, onXhr: (x: XMLHttpRequest) => void, coverFor?: string): Promise<ChatAttachment> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    onXhr(x);
    x.open("PUT", "/api/chat/media");
    x.withCredentials = true;
    x.setRequestHeader("Content-Type", f.type || "application/octet-stream");
    x.setRequestHeader("X-File-Name", encodeURIComponent(f.name));
    if (coverFor) x.setRequestHeader("X-Cover-For", coverFor);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    x.onload = () => {
      let body: any = {};
      try { body = JSON.parse(x.responseText); } catch { /* bukan JSON */ }
      if (x.status >= 200 && x.status < 300) resolve(body as ChatAttachment);
      else reject(new ApiError(body.error || `Upload gagal (${x.status})`, x.status));
    };
    x.onerror = () => reject(new ApiError("Upload terputus, cek koneksi lalu coba lagi.", 0));
    x.onabort = () => reject(new ApiError("Upload dibatalkan", 0));
    x.send(f);
  });
}

/**
 * Ambil satu frame resolusi penuh (detik ke-1, maks. lebar 1280px) sebagai cover iklan video. Thumbnail buatan Meta hanya
 * 160px. Null kalau browser tidak bisa memutar videonya (mis. MOV HEVC): server lalu memakai thumbnail Meta.
 */
export function videoCover(f: File): Promise<(Blob & { name: string }) | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f), v = document.createElement("video");
    const done = (b: Blob | null) => { clearTimeout(timer); URL.revokeObjectURL(url); v.removeAttribute("src"); resolve(b ? Object.assign(b, { name: f.name.replace(/\.[^.]+$/, "") + "-cover.jpg" }) : null); };
    const timer = setTimeout(() => done(null), 10_000);
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); };
    v.onseeked = () => {
      const w = Math.min(v.videoWidth, 1280), h = Math.round((v.videoHeight * w) / (v.videoWidth || 1));
      if (!w || !h) return done(null);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d")?.drawImage(v, 0, 0, w, h);
      c.toBlob((b) => done(b), "image/jpeg", 0.9);
    };
    v.onerror = () => done(null);
    v.src = url;
  });
}

export const fmtSize =(n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
