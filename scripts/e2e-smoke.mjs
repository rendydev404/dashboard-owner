// Smoke test E2E + screenshot (desktop & HP, terang & gelap) memakai Edge/Chrome yang sudah terpasang.
// Pemakaian: node scripts/e2e-smoke.mjs [baseUrl]   (butuh API + data demo + user owner@demo.local)
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:3000";
const OUT = "docs/screenshots";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "msedge" });
const errors = [];
const check = (ok, msg) => { if (!ok) { errors.push(msg); console.log("  ✗", msg); } else console.log("  ✓", msg); };

const STATE = `${OUT}/.auth.json`;
let authed = false;
async function session(name, viewport, theme) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: 1, ...(authed ? { storageState: STATE } : {}) });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/401/.test(m.text()) && errors.push(`${name} console: ${m.text()}`));
  return { ctx, page };
}

// --- Desktop terang: alur lengkap
{
  console.log("Desktop terang");
  const { ctx, page } = await session("desktop", { width: 1440, height: 900 }, "light");
  const t0 = Date.now();
  await page.goto(BASE);
  await page.getByLabel("Email").fill("owner@demo.local");
  await page.getByLabel("Password", { exact: true }).fill("owner-demo-12345");
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.getByText("Laba bersih").first().waitFor();
  await page.waitForTimeout(800);
  check(true, `login → KPI tampil dalam ${Date.now() - t0} ms`);
  await ctx.storageState({ path: STATE }); authed = true;
  await page.screenshot({ path: `${OUT}/01-ringkasan-desktop.png`, fullPage: true });

  const reqs = [];
  page.on("request", (r) => r.url().includes("/api/") && reqs.push(r.url()));
  await page.getByRole("button", { name: /7 hari terakhir/ }).click();
  await page.getByRole("button", { name: "Bulan lalu" }).click();
  await page.waitForTimeout(600);
  check(reqs.filter((u) => u.includes("/api/dashboard")).length === 1, `ganti periode → ${reqs.length} request API (${reqs.map((u) => new URL(u).pathname).join(", ")})`);
  check(/p=lastmonth/.test(page.url()), "periode tersimpan di URL");
  await page.getByRole("button", { name: "Periode sebelumnya" }).click();
  await page.waitForTimeout(400);
  check(/from=\d{4}-\d{2}-01/.test(page.url()), "tombol ‹ geser ke bulan sebelumnya");

  await page.getByRole("button", { name: "Kampanye" }).first().click();
  await page.getByText("Performa kampanye").waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/02-kampanye-desktop.png`, fullPage: true });

  await page.getByRole("button", { name: "Laba Rugi" }).first().click();
  await page.getByText("Laporan laba rugi per lini bisnis").waitFor();
  await page.locator('input[name="revenue"]').fill("7,5jt");
  check(await page.getByText("= Rp7.500.000").isVisible(), "pratinjau nominal 7,5jt = Rp7.500.000");
  await page.getByPlaceholder("Pilih atau ketik nama jasa").fill("Konsultasi AI 1 Jam");
  await page.getByRole("button", { name: "Simpan penjualan jasa" }).click();
  await page.getByText(/Penjualan jasa Rp7\.500\.000 tersimpan/).waitFor();
  check(true, "input penjualan jasa tersimpan");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/03-labarugi-desktop.png`, fullPage: true });

  await page.getByRole("button", { name: "Bot AI" }).first().click();
  await page.getByText("Aturan bot").waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/04-bot-desktop.png`, fullPage: true });

  // Chat
  await page.getByRole("button", { name: "Buka chat bot" }).click();
  const input = page.getByLabel("Pesan untuk bot");
  await input.fill("akun jasa");
  await input.press("Enter");
  await page.getByText(/dashboard pindah ke/).waitFor();
  check(/acc=jasa/.test(page.url()), "chat 'akun jasa' memindah dashboard");
  await input.fill("semua akun bulan lalu");
  await input.press("Enter");
  await page.waitForTimeout(300);
  check(/acc=all/.test(page.url()) && /p=lastmonth/.test(page.url()), "chat 'semua akun bulan lalu'");
  await input.fill("laba bulan lalu berapa?");
  await input.press("Enter");
  await page.getByText(/Laba bersih/).last().waitFor();
  await input.fill("pause prompt pack");
  await input.press("Enter");
  await page.getByRole("button", { name: "Ya, eksekusi" }).waitFor();
  check(true, "chat 'pause prompt pack' → kartu konfirmasi muncul");
  await page.screenshot({ path: `${OUT}/05-chat-desktop.png` });
  await page.getByRole("button", { name: "Batal", exact: true }).last().click();
  await page.getByText("Dibatalkan").waitFor();
  check(true, "konfirmasi dibatalkan, aksi tidak dieksekusi");
  await ctx.close();
}

// --- Desktop gelap
{
  console.log("Desktop gelap");
  const { ctx, page } = await session("dark", { width: 1440, height: 900 }, "dark");
  await page.goto(BASE);
  await page.getByText("Laba bersih").first().waitFor();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/06-ringkasan-dark.png`, fullPage: true });
  await ctx.close();
}

// --- HP
for (const [w, h] of [[390, 844], [360, 740]]) {
  console.log(`HP ${w}px`);
  const { ctx, page } = await session(`mobile${w}`, { width: w, height: h }, "light");
  await page.goto(BASE);
  await page.getByText("Laba bersih").first().waitFor();
  await page.waitForTimeout(900);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `tidak ada scroll horizontal di ${w}px (lebih ${overflow}px)`);
  await page.screenshot({ path: `${OUT}/07-ringkasan-hp-${w}.png`, fullPage: true });
  if (w === 390) {
    await page.getByRole("navigation", { name: "Menu" }).getByRole("button", { name: "Kampanye" }).click();
    await page.getByText("Performa kampanye").waitFor();
    await page.waitForTimeout(500);
    const o2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(o2 <= 0, `kampanye tanpa scroll horizontal di HP (lebih ${o2}px)`);
    await page.screenshot({ path: `${OUT}/08-kampanye-hp.png`, fullPage: true });
    await page.getByRole("navigation", { name: "Menu" }).getByRole("button", { name: "Laba Rugi" }).click();
    await page.getByText("Laporan laba rugi per lini bisnis").waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/09-labarugi-hp.png`, fullPage: true });
  }
  await ctx.close();
}

await browser.close();
if (errors.length) { console.log("\nMASALAH:\n" + errors.join("\n")); process.exit(1); }
console.log("\nSemua cek lolos.");
