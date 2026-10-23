// HTTP worker render. Hanya dipanggil server dashboard (jaringan internal Docker), dijaga token Bearer.
//   POST   /jobs                    spec JSON → {id}
//   PUT    /jobs/:id/assets/:name   isi file mentah (foto/video adegan, logo)
//   POST   /jobs/:id/start          masuk antrean
//   GET    /jobs/:id                status, progres, QC
//   GET    /jobs/:id/video|cover    hasil MP4 / PNG cover
//   DELETE /jobs/:id                hapus job & filenya
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import {
  ASSET_MAX, ASSET_NAME, assetFile, coverFile, createJob, getJob, initJobs, queueInfo, removeJob, startJob, videoFile, type Job,
} from "./jobs";
import { voiceProvider } from "./voice";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.WORKER_TOKEN ?? "";
if (TOKEN.length < 24) { console.error("WORKER_TOKEN wajib diisi (minimal 24 karakter)"); process.exit(1); }

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
};
const authed = (req: IncomingMessage) => {
  const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
};
async function readJson(req: IncomingMessage, max = 64 * 1024) {
  let size = 0; const parts: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error("Body terlalu besar"), { status: 413 }); parts.push(c); }
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}
const view = (j: Job) => ({ id: j.id, status: j.status, progress: j.progress, error: j.error, voice: j.voice, qc: j.qc, result: j.result, createdAt: j.createdAt });

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, type: string) {
  if (!existsSync(file)) return json(res, 404, { error: "File belum ada" });
  res.writeHead(200, { "Content-Type": type, "Content-Length": statSync(file).size, "Cache-Control": "no-store" });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file).pipe(res);
}

async function uploadAsset(req: IncomingMessage, res: ServerResponse, j: Job, name: string) {
  if (j.status !== "uploading") return json(res, 409, { error: "Job sudah dimulai" });
  if (!ASSET_NAME.test(name)) return json(res, 400, { error: "Nama aset tidak valid" });
  if (Number(req.headers["content-length"] ?? 0) > ASSET_MAX) return json(res, 413, { error: "Aset maks. 100 MB" });
  let size = 0;
  const cap = new Transform({ transform(c: Buffer, _e, cb) { size += c.length; cb(size > ASSET_MAX ? Object.assign(new Error("Aset maks. 100 MB"), { status: 413 }) : null, c); } });
  const file = assetFile(j.id, name);
  try { await pipeline(req, cap, createWriteStream(file, { mode: 0o600 })); }
  catch (e) { await rm(file, { force: true }); throw e; }
  json(res, 201, { name, size });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://worker");
  const p = url.pathname.split("/").filter(Boolean);
  if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true, ...queueInfo(), voice: voiceProvider() });
  if (!authed(req)) return json(res, 401, { error: "Token salah" });
  if (p[0] !== "jobs") return json(res, 404, { error: "Tidak ada" });

  if (p.length === 1 && req.method === "POST") return json(res, 201, view(createJob(await readJson(req))));
  const j = p[1] ? getJob(p[1]) : null;
  if (!j) return json(res, 404, { error: "Job tidak ditemukan" });
  if (p.length === 2 && req.method === "GET") return json(res, 200, view(j));
  if (p.length === 2 && req.method === "DELETE") { removeJob(j.id); return json(res, 200, { ok: true }); }
  if (p[2] === "assets" && p[3] && req.method === "PUT") return uploadAsset(req, res, j, p[3]);
  if (p[2] === "start" && req.method === "POST") { startJob(j); return json(res, 202, view(j)); }
  if (p[2] === "video" && (req.method === "GET" || req.method === "HEAD")) return j.status === "done" ? sendFile(req, res, videoFile(j.id), "video/mp4") : json(res, 409, { error: "Video belum selesai" });
  if (p[2] === "cover" && (req.method === "GET" || req.method === "HEAD")) return sendFile(req, res, coverFile(j.id), "image/png");
  json(res, 404, { error: "Tidak ada" });
}

initJobs();
createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e instanceof ZodError ? 400 : e instanceof SyntaxError ? 400 : (e as { status?: number }).status ?? 500;
    const message = e instanceof ZodError ? "Spec tidak valid: " + e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message;
    if (status >= 500) console.error(JSON.stringify({ level: "error", msg: "request gagal", path: req.url, error: message }));
    if (!res.headersSent) json(res, status, { error: message }); else res.destroy();
  });
}).listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ level: "info", msg: "creative-worker jalan", port: PORT, voice: voiceProvider() })));
