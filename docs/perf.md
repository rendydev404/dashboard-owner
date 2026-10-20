# Catatan performa

Diukur 19 Okt 2026 di laptop dev (Windows, Postgres 17 lokal via embedded-postgres), bundle produksi `node dist/index.js`, data demo **365 hari × 2 akun** (2.961 baris `campaign_daily`, 17.494 baris `account_hourly`, 3.900 penjualan). Ini lebih besar dari volume akun asli saat ini (±14 kampanye).

## API (`node scripts/bench-api.mjs`, 30 periode 90 hari berbeda per endpoint)

| Endpoint | p50 dingin | p95 dingin | p50 kena cache | Payload (sebelum gzip) |
|---|---|---|---|---|
| `/api/dashboard` | 7,8 ms | 15,2 ms | 1,9 ms | 10,9 KB |
| `/api/campaigns` | 3,1 ms | 4,1 ms | 1,3 ms | 4,3 KB |
| `/api/hourly` | 4,3 ms | 6,7 ms | 1,4 ms | 3,5 KB |
| `/api/products` | 3,7 ms | 6,7 ms | 1,2 ms | 1,4 KB |
| `/api/pl` | 9,8 ms | 11,6 ms | 1,2 ms | 2,7 KB |

Target PRD: p95 ≤ 150 ms. Request ulang tanpa perubahan data dijawab `304` (ETag berbasis versi data).

## Query (`npx tsx src/cli/explain.ts`)

| Query | Execution time | Buffers | Rencana |
|---|---|---|---|
| `campaign_daily` sekarang + pembanding (180 hari, `SUM … FILTER`) | 1,18 ms | 64 hit | Seq scan: rentang mencakup ±50% tabel kecil, jadi lebih murah dari index |
| `sales` per lini + join produk | 2,46 ms | 120 hit | Seq scan (alasan sama) |
| `account_hourly` per jam (90 hari) | 1,63 ms | 78 hit | Bitmap index scan `account_hourly_pkey` |

Index `(account_id, date) INCLUDE (...)` dan `sales (line, date) WHERE deleted_at IS NULL` dipakai planner begitu rentang lebih sempit dari tabel (periode harian/mingguan, data bertahun-tahun).

## Frontend (`vite build`)

| Aset | Ukuran gzip | Kapan dimuat |
|---|---|---|
| JS awal (index + react + react-query) | 77,5 KB | Saat buka app |
| CSS | 8,2 KB | Saat buka app |
| Font Inter (latin, variable) | 48 KB woff2 | Saat buka app (subset lain hanya kalau ada karakternya) |
| Chart.js | 60,3 KB | Saat grafik pertama tampil |
| Halaman lain (Kampanye, Laba Rugi, Bot, dst.) | 1,4–5,1 KB per halaman | Saat dibuka / di-prefetch 1,5 dtk setelah load |

- Ganti periode/akun: **1 request** (`/api/dashboard`), diverifikasi di E2E.
- Donut & ring = SVG murni (tanpa library).
- Realtime: 1 koneksi SSE, server hanya mengirim nomor versi data. Client invalidasi query dengan debounce 2 dtk.
- Login sampai KPI tampil (E2E, termasuk mengetik form): ±1,4–1,5 dtk.
