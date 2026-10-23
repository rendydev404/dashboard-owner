import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveDir } from "../src/assets-server";

let srv: Awaited<ReturnType<typeof serveDir>>;
const body = Buffer.from("0123456789abcdefghij"); // 20 byte

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "assets-test-"));
  writeFileSync(path.join(dir, "v.mp4"), body);
  writeFileSync(path.join(path.dirname(dir), "rahasia.txt"), "di luar folder");
  srv = await serveDir(dir);
});
afterAll(() => srv.close());

describe("server aset sementara", () => {
  it("menyajikan file utuh dengan tipe yang benar", async () => {
    const r = await fetch(`${srv.url}/v.mp4`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await r.arrayBuffer()).equals(body)).toBe(true);
  });
  it("Range: a-b, a-, dan -n (n byte terakhir) → 206", async () => {
    const get = async (range: string) => {
      const r = await fetch(`${srv.url}/v.mp4`, { headers: { Range: range } });
      return { status: r.status, cr: r.headers.get("content-range"), text: await r.text() };
    };
    expect(await get("bytes=2-5")).toEqual({ status: 206, cr: "bytes 2-5/20", text: "2345" });
    expect(await get("bytes=15-")).toEqual({ status: 206, cr: "bytes 15-19/20", text: "fghij" });
    expect(await get("bytes=-3")).toEqual({ status: 206, cr: "bytes 17-19/20", text: "hij" });
    expect((await get("bytes=50-60")).status).toBe(416);
  });
  it("tidak bisa keluar dari folder dan file tak ada → 404", async () => {
    expect((await fetch(`${srv.url}/nope.mp4`)).status).toBe(404);
    // fetch menormalkan "..", jadi kirim mentah lewat soket.
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      const u = new URL(srv.url);
      const q = request({ host: u.hostname, port: u.port, path: "/..%2Frahasia.txt", method: "GET" }, (res) => { resolve(res.statusCode ?? 0); res.resume(); });
      q.end();
    });
    expect([403, 404]).toContain(status);
  });
});
