# Dashboard Iklan & Laba Rugi

Dashboard owner untuk iklan Meta, omzet riil (lynk.id + jasa manual), laba rugi per lini, dan bot AI dengan kontrol iklan berkonfirmasi. Spesifikasi: [PRD.md](PRD.md) · rencana teknis: [PLANNING.md](PLANNING.md) · angka performa: [docs/perf.md](docs/perf.md).

```
apps/api         Hono + postgres.js: auth, agregasi, input manual, Meta sync & aksi, webhook lynk.id, bot (Claude)
apps/web         React + Vite + Tailwind v4 + TanStack Query (UI mengikuti reference/design-reference.webp)
packages/shared  Rumus KPI, periode, format rupiah, aturan rekomendasi, parser perintah bot (dipakai FE & BE)
db/migrations    Skema SQL
scripts          dev-db (Postgres lokal), e2e-smoke, bench-api
```

## Menjalankan di lokal (tanpa Docker)

```bash
pnpm install
```
```bash
pnpm dev:db
```
Di terminal lain (Postgres 17 lokal di port 54329, data di `.pgdata/`):
```bash
pnpm seed:demo
```
```bash
pnpm user:create owner@demo.local "Owner Demo" owner
```
```bash
pnpm dev:api
```
```bash
pnpm dev:web
```
Buka http://localhost:5173. File `.env` lokal berisi `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres`. Lihat [.env.example](.env.example) untuk semua variabel.

Tanpa jalur Meta (lihat bawah) dashboard hanya menampilkan data yang sudah ada di database. Tanpa `ANTHROPIC_API_KEY` bot memakai mode aturan (tetap bisa tanya angka, pindah tampilan, ubah aturan, dan mengusulkan aksi).

## Jalur data Meta

Dashboard memilih jalur otomatis (`META_BRIDGE=auto`):

1. **MCP Meta Ads (jembatan Claude Code).** Sama seperti project `bot_iklan_fb/hermes-ads` (`builder/meta_mcp.py`): dashboard memanggil `https://mcp.facebook.com/ads` lewat JSON-RPC, tanpa LLM, memakai token OAuth dari login Claude Code user `claude-ads` di VPS (berlaku sekitar 60 hari tanpa refresh). Dipakai kalau file `META_MCP_CRED` ada. Mendukung baca (sync) dan tulis (Pause / Aktifkan / Scale lewat `ads_update_entity` & `ads_activate_entity`).
2. **Graph API.** Cadangan, pakai `META_SYSTEM_USER_TOKEN` dari Business Manager.

Uji jalur MCP tanpa menyentuh Meta: `pnpm --filter @iklan/api exec tsx --env-file=../../.env src/cli/verify-mcp-bridge.ts <daily.json> <hourly.json>` (memutar ulang respons asli sebagai server MCP tiruan).

## Tes

```bash
pnpm test
```
```bash
node scripts/e2e-smoke.mjs
```
E2E memakai Edge/Chrome yang sudah terpasang (`PW_CHANNEL=chrome` untuk Chrome), mengambil screenshot ke `docs/screenshots/`.

## Deploy ke Coolify (VPS 76.13.193.138)

1. **Database:** buat resource PostgreSQL `iklan-db` (image `postgres:18-alpine`, limit memori 256 MB, backup harian 03:00, retensi 14 hari).
2. **Aplikasi:** sumber = repo GitHub privat ini, build pack **Dockerfile**, port `3000`, healthcheck `/healthz`, limit memori 384 MB / CPU 0,5, pasang domain.
3. **Environment:** isi semua variabel dari `.env.example` (tandai sebagai secret). `DATABASE_URL` memakai hostname internal `iklan-db`.
3a. **Token Meta lewat MCP (VPS 3, sekali saja).** Claude Code terpasang untuk user `claude-ads` (uid 2001, home `/var/lib/claude-ads`) dengan MCP `meta_ads` (`https://mcp.facebook.com/ads`). Login: `sudo -u claude-ads -i claude` → login akun Claude → `/mcp` → meta_ads → Authenticate. Jangan mount `.credentials.json` utuh: file itu juga berisi login akun Claude.
   ```bash
   cp deploy/export-meta-token.py /usr/local/lib/export-meta-token.py
   cp deploy/meta-token-export.service deploy/meta-token-export.timer /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now meta-token-export.timer
   ```
   Timer tiap 10 menit menyalin HANYA token Meta ke `/opt/ads-dashboard/meta-token.json` (0400, uid 1000). Di Coolify: bind mount **direktori** `/opt/ads-dashboard` → `/run/meta` (bukan file, supaya penggantian atomik terlihat di container) dan env `META_MCP_CRED=/run/meta/meta-token.json`. Token berlaku ±60 hari; login ulang `/mcp` sebelum habis (dashboard memberi peringatan 7 hari sebelumnya).
   - VPS lama (76.13.193.138) punya login `claude-ads` sendiri untuk `ads-snapshot`, `ads-report-web`, dan `ads-builder`; tidak bergantung pada dashboard.
   - **Resource:** app 384 MB / 0,5 CPU, Postgres 256 MB / 0,5 CPU (`max_connections=20`, `shared_buffers=64MB`). Sync `recent` (2 hari) tiap `SYNC_INTERVAL_MIN`=15 mnt (120 mnt di jam 00–06), `nightly` 28 hari jam 02, backfill 180 hari sekali per akun baru. Lynk realtime lewat webhook + SSE.
3b. **Bot AI lewat Claude Code (VPS 3).** Bot memakai login Claude user `claude-ads` (langganan), tanpa API key.
   - `deploy/claude-bridge.mjs` (systemd `claude-bridge`, user claude-ads) listen di gateway Docker `10.0.1.1:8790`, wajib `BRIDGE_TOKEN` (`/etc/claude-bridge.env`, 0600). Tiap pertanyaan menjalankan `claude -p` **tanpa tool bawaan** (`--tools ""`, tanpa Bash/file/web), maks. 2 proses bersamaan, timeout 170 dtk, proses dihentikan bila user menutup chat.
   - Tool bot = server MCP internal dashboard `/internal/mcp` dengan token sekali pakai per pesan (`chat-sessions.ts`); Caddy menolak `/internal/*` dari internet.
   - Env Coolify: `CLAUDE_BRIDGE_URL=http://10.0.1.1:8790`, `CLAUDE_BRIDGE_TOKEN` (sama dengan BRIDGE_TOKEN), `CLAUDE_MCP_URL=http://127.0.0.1:3210/internal/mcp`. Tanpa env ini bot memakai `ANTHROPIC_API_KEY` (kalau ada) atau mode aturan.
   - Widget di chat (kartu KPI, progress ROAS vs impas, bar kampanye/jam/produk) dibangun dari hasil tool (`chat-widgets.ts`), bukan ditulis model.
4. **Deploy.** Migrasi berjalan otomatis saat boot. Buat akun owner dari terminal container Coolify:
   ```bash
   node dist/cli/user-create.js owner@domain.com "Nama Owner" owner
   ```
5. **Pengaturan → Akun iklan → Tambah:** isi ID `1392053332395676` (Produk Digital). Backfill 180 hari jalan otomatis.
6. **lynk.id:** di dashboard lynk.id isi URL webhook `https://<domain>/webhooks/lynk`, lalu cocokkan merchant key dengan env `LYNK_MERCHANT_KEY`. Uji dengan 1 transaksi.

## Keamanan

- Secret (token Meta, merchant key lynk, API key Claude, session secret) hanya di env, tidak di repo atau bundle web.
- Bot dan tombol tabel hanya membuat aksi `pending`. Eksekusi ke Meta hanya lewat `POST /api/actions/:id/confirm` (owner) dan kedaluwarsa dalam 10 menit.
- Login argon2id + rate limit 5x/15 mnt, cookie `__Host-` HttpOnly, cek Origin untuk request tulis, CSP ketat.
