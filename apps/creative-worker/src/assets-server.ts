// Server file lokal sementara: Remotion (Chrome + pembaca video) mengambil foto/video/audio lewat HTTP.
// Hanya 127.0.0.1, hanya satu folder, dan mendukung Range supaya video bisa di-seek.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
};

export function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const root = path.resolve(dir);
  const server = createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = path.resolve(root, "." + rel);
    if (!file.startsWith(root + path.sep)) return void res.writeHead(403).end();
    let size = 0;
    try { const st = statSync(file); if (!st.isFile()) throw new Error("bukan file"); size = st.size; } catch { return void res.writeHead(404).end(); }
    const headers: Record<string, string | number> = {
      "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store",
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (!m || (m[1] === "" && m[2] === "")) {
      res.writeHead(200, { ...headers, "Content-Length": size });
      return void (req.method === "HEAD" ? res.end() : createReadStream(file).pipe(res));
    }
    // "bytes=a-b", "bytes=a-", atau "bytes=-n" (n byte terakhir).
    const start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
    const end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start >= size || start > end) return void res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file, { start, end }).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    }));
  });
}
