// Ukur waktu respons endpoint agregat (dingin = cache server tidak kena, hangat = kena cache).
// Pemakaian: node scripts/bench-api.mjs [baseUrl]
const BASE = process.argv[2] || "http://localhost:3000";
const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: BASE },
  body: JSON.stringify({ email: process.env.BENCH_EMAIL || "owner@demo.local", password: process.env.BENCH_PASSWORD || "owner-demo-12345" }),
});
const cookie = login.headers.get("set-cookie")?.split(";")[0];
if (!cookie) { console.error("Login gagal", login.status); process.exit(1); }

const pad = (n) => String(n).padStart(2, "0");
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = new Date();
const q = (s) => s.sort((a, b) => a - b);
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

async function timed(url) {
  const t = performance.now();
  const r = await fetch(url, { headers: { Cookie: cookie, "Accept-Encoding": "gzip" } });
  const buf = await r.arrayBuffer();
  return { ms: performance.now() - t, bytes: buf.byteLength, gz: r.headers.get("content-encoding") };
}

const rows = [];
for (const ep of ["dashboard", "campaigns", "hourly", "products", "pl"]) {
  const cold = [], warm = [];
  let size = 0;
  for (let i = 0; i < 30; i++) {
    // Periode 90 hari yang bergeser 1 hari tiap iterasi → kunci cache selalu baru (dingin).
    const to = new Date(today); to.setDate(to.getDate() - i);
    const from = new Date(to); from.setDate(from.getDate() - 89);
    const url = `${BASE}/api/${ep}?acc=all&from=${day(from)}&to=${day(to)}`;
    const c = await timed(url); cold.push(c.ms); size = c.bytes;
    warm.push((await timed(url)).ms);
  }
  rows.push({ endpoint: `/api/${ep} (90 hari, semua akun)`, p50_dingin: pct(q(cold), 0.5).toFixed(1) + " ms", p95_dingin: pct(q(cold), 0.95).toFixed(1) + " ms", p50_cache: pct(q(warm), 0.5).toFixed(1) + " ms", payload: (size / 1024).toFixed(1) + " KB" });
}
console.table(rows);
