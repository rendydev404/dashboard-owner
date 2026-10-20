# PLANNING — Dashboard Iklan & Laba Rugi

Rencana teknis lengkap untuk [PRD.md](PRD.md). Urutan baca: §1 arsitektur → §2 akses yang harus disiapkan → §3–§8 desain teknis → §9 fase kerja (checklist) → §10–§14 uji, deploy, operasional.

---

## 0. Ringkasan keputusan

| Keputusan | Pilihan | Alasan |
|---|---|---|
| Bentuk aplikasi | **1 container**: API + file web statis + worker sinkron dalam satu proses Node | VPS sudah menjalankan ±22 app; 1 proses kecil paling hemat RAM |
| Backend | Node 22 LTS + **Hono** + **postgres.js** + Zod | Hono ±14 KB dan cepat; postgres.js tanpa ORM berat, query SQL eksplisit dan mudah di-`EXPLAIN` |
| Database | **Postgres 18 terpisah** (`iklan-db`) di Coolify | Tidak mengganggu `marcom-database`; backup dan restore sendiri |
| Frontend | **Vite + React 18 + TypeScript + Tailwind v4 + TanStack Query** | Komponen mudah dirawat; Query mengurus cache, invalidasi, dan optimistic update |
| Grafik | **Chart.js 4** (tree-shaken, dimuat lazy) | Sudah dipakai prototipe dan ringan; donut, bar, line, dan ring bisa semua |
| Data Meta | **Marketing API langsung** dengan System User token | MCP di Claude Code tidak bisa dipakai backend (OAuth sesi Claude) |
| Data lynk.id | Webhook `payment.received` + verifikasi SHA-256 | Real-time, tanpa polling |
| Bot | **Claude API** (`claude-sonnet-5-5`) + tool calling + **router lokal** untuk perintah sederhana | Analisis pintar; perintah sederhana instan dan gratis |
| Aksi iklan | Model hanya bisa **mengusulkan**; eksekusi lewat endpoint konfirmasi yang dipicu tombol user | Mustahil tereksekusi tanpa konfirmasi, meski model "berhalusinasi" |
| Realtime | **SSE** satu kanal, kirim "versi data berubah" saja (bukan data) | Ringan; client invalidasi query sendiri dengan debounce |
| Deploy | Coolify → Dockerfile multi-stage dari repo GitHub privat | Pola yang sama dengan app lain di VPS |

---

## 1. Arsitektur

```
                         ┌──────────────────────── VPS 76.13.193.138 (Coolify + Traefik) ───────────────────────┐
                         │                                                                                     │
 Browser / PWA  ──HTTPS──┼─► iklan-app (Node 22, 1 container, RAM ≤384MB)                                      │
  React SPA              │    ├─ GET  /            → web statis (Vite build, cache 1 thn untuk aset ber-hash) │
  TanStack Query ◄─SSE───┼────├─ /api/*            → Hono: auth, agregasi, input manual, chat, aksi           │
                         │    ├─ /webhooks/lynk    → verifikasi signature → sales                             │
                         │    ├─ worker sync Meta  → tiap 30 mnt + 02:00 WIB (advisory lock pg)               │
                         │    └─ rule engine (P1)  → setelah sync → notif / autopilot                          │
                         │            │                                                                        │
                         │            ▼                                                                        │
                         │   iklan-db (Postgres 18, RAM ≤256MB, backup harian)                                │
                         │                                                                                     │
                         │   WAHA (sudah ada) ◄── notif WA (P1)                                                │
                         └─────────────────────────────────────────────────────────────────────────────────────┘
        ▲                         │                         │
        │ webhook POST            │ Graph API (insights,    │ Messages API
   lynk.id                        ▼ status, budget)         ▼ (tool calling, streaming)
                            Meta Marketing API          Claude API
```

### Alur data
1. **Meta → DB:** worker mengambil insights level kampanye per hari dan level akun per jam, lalu upsert batch ke `campaign_daily` dan `account_hourly`. Metadata kampanye (status, budget) ikut disimpan di `campaigns`.
2. **lynk.id → DB:** webhook disimpan mentah di `lynk_events`, lalu dipecah per item ke `sales`.
3. **Input manual → DB:** `sales` (jasa) dan `manual_costs`.
4. **DB → UI:** endpoint agregat per tab (1 request per tab) menjalankan SQL `SUM … FILTER` untuk periode sekarang dan pembanding dalam **satu query**. Rumus turunan dihitung di modul `shared` yang sama dengan frontend.
5. **Setiap tulis** (sync selesai, webhook, input) menaikkan `data_version`. Cache server invalid, SSE mengirim `{"type":"version","v":123}`, dan client menjalankan `invalidateQueries` dengan debounce 2 dtk.

---

## 2. Akses & bahan yang harus disiapkan (Fase 0)

| # | Bahan | Cara mendapatkan | Disimpan di |
|---|---|---|---|
| A1 | **Meta System User token** (`ads_read`, `ads_management`, `business_management`) | Business Manager *DNR Media* (`1394003552286985`) → Pengaturan Bisnis → Pengguna → **Pengguna Sistem** → Tambah (Admin) → Tetapkan aset: ad account `1392053332395676` (+ akun jasa) dengan izin **Kelola kampanye** → Buat token (pilih App, kedaluwarsa: **Tidak pernah**) | Env `META_SYSTEM_USER_TOKEN` |
| A2 | **Meta App** (tipe Business) + App Secret | developers.facebook.com → My Apps → Create → Business → hubungkan ke BM DNR Media, tambah produk *Marketing API* | Env `META_APP_ID`, `META_APP_SECRET` (untuk `appsecret_proof`) |
| A3 | **Merchant key lynk.id** | Sudah diberikan (`BaWg…C9iS`). Pastikan URL webhook disimpan di dashboard lynk.id **setelah** app live | Env `LYNK_MERCHANT_KEY` |
| A4 | **Anthropic API key** | console.anthropic.com → API Keys (pasang limit bulanan) | Env `ANTHROPIC_API_KEY` |
| A5 | **Domain** | DNS A record → `76.13.193.138` (bisa lewat MCP hostinger-dns) | Coolify domain app |
| A6 | **Repo GitHub privat** | Org `dev-sukashawarma` (seperti app lain) atau akun owner; hubungkan ke GitHub App Coolify | — |
| A7 | **Nomor WA owner + session WAHA** (P1) | WAHA `blast.sukashawarma.com` | Env `WAHA_URL`, `WAHA_API_KEY`, `OWNER_WA` |

> MCP Meta Ads di Claude Code tetap dipakai untuk: verifikasi angka saat QA (bandingkan hasil sync vs `ads_get_ad_entities`), cek nama kampanye/field, dan investigasi manual.

### Env vars lengkap (`.env.example`)
```
NODE_ENV=production
PORT=3000
TZ=Asia/Jakarta
APP_URL=https://iklan.example.com
DATABASE_URL=postgres://iklan:***@iklan-db:5432/iklan
SESSION_SECRET=<64 byte acak>
META_API_VERSION=v24.0            # naikkan sesuai versi stabil terbaru
META_APP_ID=
META_APP_SECRET=
META_SYSTEM_USER_TOKEN=
LYNK_MERCHANT_KEY=
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-sonnet-5-5
SYNC_INTERVAL_MIN=30
CHAT_RATE_PER_HOUR=60
WAHA_URL=                         # P1
WAHA_API_KEY=                     # P1
OWNER_WA=                         # P1
```

---

## 3. Struktur repo

```
dashboard-iklan/
├─ apps/
│  ├─ api/
│  │  ├─ src/
│  │  │  ├─ index.ts              # boot Hono, static, scheduler
│  │  │  ├─ env.ts                # validasi env (Zod), gagal boot kalau kurang
│  │  │  ├─ db.ts                 # postgres.js pool (max 5)
│  │  │  ├─ auth/                 # login, sesi, middleware role
│  │  │  ├─ routes/               # dashboard, campaigns, hourly, products, pl, bot, manual, settings, chat, actions, events(SSE), export
│  │  │  ├─ queries/              # SQL agregasi (1 file per tab)
│  │  │  ├─ meta/                 # client Graph API, sync, actions (pause/activate/budget)
│  │  │  ├─ lynk/                 # webhook handler, signature, mapper
│  │  │  ├─ bot/                  # system prompt, tools, executor, confirm flow
│  │  │  ├─ rules/                # rule engine autopilot (P1)
│  │  │  ├─ cache.ts              # LRU + data_version
│  │  │  └─ notify.ts             # WAHA (P1)
│  │  └─ test/
│  └─ web/
│     ├─ index.html
│     ├─ src/
│     │  ├─ main.tsx, App.tsx
│     │  ├─ styles/tokens.css     # token desain terang/gelap (§7)
│     │  ├─ layout/               # Sidebar, Topbar, BottomNav, Shell
│     │  ├─ components/           # KpiCard, DonutCard, RingCard, BarTrend, LineTrend, DataTable, CardList, PeriodPicker, AccountPicker, ThemeToggle, ConfirmDialog, Toast, Skeleton, EmptyState
│     │  ├─ pages/                # Ringkasan, Kampanye, PerJam, Produk, LabaRugi, Bot, Pengaturan, Login
│     │  ├─ chat/                 # ChatPanel, ActionCard, localRouter.ts
│     │  ├─ api/                  # fetcher + hooks React Query
│     │  └─ state/                # url state (acc, from, to, tab)
│     └─ public/                  # manifest, ikon, ilustrasi
├─ packages/shared/
│  ├─ dates.ts                    # presetRange, shiftRange, compareRange, lenDays (porting dari prototipe)
│  ├─ metrics.ts                  # computeKpis(raw, settings) → semua rumus PRD §8
│  ├─ rules.ts                    # recFor(campaign, settings)
│  ├─ money.ts                    # parseRp, rp, rpk, pct, dec
│  └─ types.ts                    # tipe respons API (dipakai FE & BE)
├─ db/
│  ├─ migrations/0001_init.sql …
│  └─ seed/demo.ts                # porting sampleDB() prototipe → data dev 365 hari
├─ scripts/ bench-api.ts, explain.ts
├─ Dockerfile
├─ docker-compose.dev.yml         # postgres lokal
├─ .env.example
└─ pnpm-workspace.yaml
```

---

## 4. Skema database

```sql
-- 0001_init.sql
CREATE TYPE business_line AS ENUM ('digital','jasa');
CREATE TYPE user_role     AS ENUM ('owner','admin');
CREATE TYPE bot_mode      AS ENUM ('off','suggest','auto');
CREATE TYPE action_status AS ENUM ('pending','executed','failed','cancelled','expired','reverted');
CREATE TYPE action_source AS ENUM ('chat','table','rule_engine');

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,              -- argon2id
  role          user_role NOT NULL DEFAULT 'admin',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          text PRIMARY KEY,             -- 32 byte acak, base64url
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE ad_accounts (
  id                 text PRIMARY KEY,      -- '1392053332395676' (tanpa 'act_')
  display_name       text NOT NULL,
  line               business_line NOT NULL,
  currency           text NOT NULL DEFAULT 'IDR',
  timezone           text NOT NULL DEFAULT 'Asia/Jakarta',
  result_action_type text NOT NULL,         -- digital: 'omni_purchase'; jasa: 'onsite_conversion.messaging_conversation_started_7d' | 'lead'
  bot_mode           bot_mode NOT NULL DEFAULT 'suggest',
  active             boolean NOT NULL DEFAULT true,
  last_synced_at     timestamptz,
  sort_order         smallint NOT NULL DEFAULT 0
);

CREATE TABLE account_settings (
  account_id        text PRIMARY KEY REFERENCES ad_accounts(id) ON DELETE CASCADE,
  target_roas       numeric(6,2) NOT NULL,
  max_cpa           bigint,                 -- Rp, digital
  max_cpl           bigint,                 -- Rp, jasa
  fee_pct           numeric(5,2) NOT NULL DEFAULT 0,
  ad_tax_pct        numeric(5,2) NOT NULL DEFAULT 11,
  scale_step_pct    smallint NOT NULL DEFAULT 20,
  kill_after_spend  bigint NOT NULL,
  max_daily_budget  bigint,                 -- pagar autopilot (P1)
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        bigint REFERENCES users(id)
);

CREATE TABLE campaigns (
  id               text PRIMARY KEY,
  account_id       text NOT NULL REFERENCES ad_accounts(id),
  name             text NOT NULL,
  status           text NOT NULL,           -- ACTIVE | PAUSED | ARCHIVED (yang diset user)
  effective_status text NOT NULL,
  objective        text,
  daily_budget     bigint,                  -- null kalau budget di level ad set (ABO)
  lifetime_budget  bigint,
  is_cbo           boolean NOT NULL DEFAULT false,
  created_time     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_account_idx ON campaigns (account_id);

CREATE TABLE campaign_daily (
  campaign_id    text   NOT NULL REFERENCES campaigns(id),
  date           date   NOT NULL,
  account_id     text   NOT NULL,           -- denormalisasi supaya filter tanpa join
  spend          bigint NOT NULL DEFAULT 0,
  impressions    bigint NOT NULL DEFAULT 0,
  clicks         bigint NOT NULL DEFAULT 0, -- inline_link_clicks
  leads          integer NOT NULL DEFAULT 0,
  purchases      integer NOT NULL DEFAULT 0,
  purchase_value bigint NOT NULL DEFAULT 0, -- nilai pixel (ROAS Meta)
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, date)
);
-- Query utama: WHERE account_id = ANY($1) AND date BETWEEN $2 AND $3
CREATE INDEX campaign_daily_acc_date_idx ON campaign_daily (account_id, date)
  INCLUDE (spend, impressions, clicks, leads, purchases, purchase_value);

CREATE TABLE account_hourly (
  account_id  text     NOT NULL,
  date        date     NOT NULL,
  hour        smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  spend       bigint   NOT NULL DEFAULT 0,
  impressions bigint   NOT NULL DEFAULT 0,
  clicks      bigint   NOT NULL DEFAULT 0,
  leads       integer  NOT NULL DEFAULT 0,
  purchases   integer  NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, date, hour)      -- PK sekaligus index untuk filter
);

CREATE TABLE products (
  id          bigserial PRIMARY KEY,
  line        business_line NOT NULL,
  name        text NOT NULL,
  price       bigint,
  cogs        bigint NOT NULL DEFAULT 0,    -- HPP standar per unit
  url         text,
  lynk_uuid   text UNIQUE,                  -- items[].uuid dari webhook
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (line, name)
);

CREATE TABLE sales (
  id           bigserial PRIMARY KEY,
  line         business_line NOT NULL,
  account_id   text REFERENCES ad_accounts(id),  -- akun jasa (manual); null untuk lynk
  product_id   bigint REFERENCES products(id),
  product_name text NOT NULL,               -- snapshot nama saat transaksi
  date         date NOT NULL,               -- tanggal WIB
  occurred_at  timestamptz NOT NULL,
  qty          integer NOT NULL DEFAULT 1,
  revenue      bigint NOT NULL,
  cogs         bigint,                      -- null → pakai products.cogs * qty
  client       text,
  source       text,                        -- 'iklan' | 'organik' | 'referral' | 'lynk'
  channel      text NOT NULL,               -- 'lynk' | 'manual'
  lynk_ref_id  text,
  lynk_item_ix smallint,
  created_by   bigint REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  UNIQUE (lynk_ref_id, lynk_item_ix)        -- idempotensi per item lynk
);
CREATE INDEX sales_line_date_idx ON sales (line, date) WHERE deleted_at IS NULL;
CREATE INDEX sales_manual_recent_idx ON sales (created_at DESC, id DESC) WHERE channel = 'manual' AND deleted_at IS NULL;

CREATE TABLE fixed_costs (
  id           bigserial PRIMARY KEY,
  line         business_line NOT NULL,
  name         text NOT NULL,
  monthly      bigint NOT NULL,
  active_from  date NOT NULL DEFAULT CURRENT_DATE,
  active_to    date
);

CREATE TABLE manual_costs (
  id          bigserial PRIMARY KEY,
  line        business_line NOT NULL,
  date        date NOT NULL,
  name        text NOT NULL,
  amount      bigint NOT NULL,
  created_by  bigint REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX manual_costs_line_date_idx ON manual_costs (line, date) WHERE deleted_at IS NULL;

CREATE TABLE lynk_events (
  message_id    text PRIMARY KEY,
  ref_id        text NOT NULL,
  event         text NOT NULL,
  signature_ok  boolean NOT NULL,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  error         text
);
CREATE INDEX lynk_events_unprocessed_idx ON lynk_events (received_at) WHERE processed_at IS NULL;

CREATE TABLE bot_actions (
  id            bigserial PRIMARY KEY,
  account_id    text REFERENCES ad_accounts(id),
  campaign_id   text REFERENCES campaigns(id),
  action        text NOT NULL,              -- pause | activate | scale | update_rule | schedule
  params        jsonb NOT NULL,             -- {before:{status,daily_budget}, after:{...}, pct, field, value}
  source        action_source NOT NULL,
  status        action_status NOT NULL,
  reason        text,
  requested_by  bigint REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,                -- pending kedaluwarsa 10 mnt
  executed_at   timestamptz,
  meta_response jsonb,
  error         text
);
CREATE INDEX bot_actions_acc_created_idx ON bot_actions (account_id, created_at DESC, id DESC);

CREATE TABLE chat_messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL,
  user_id         bigint NOT NULL REFERENCES users(id),
  role            text NOT NULL,            -- user | assistant | tool
  content         jsonb NOT NULL,
  input_tokens    integer, output_tokens integer, cache_read_tokens integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_conv_idx ON chat_messages (conversation_id, id);

CREATE TABLE sync_runs (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,                -- recent | nightly | backfill | manual
  account_id  text,
  since       date, until date,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  rows        integer,
  status      text NOT NULL DEFAULT 'running',
  error       text
);

CREATE TABLE app_state (key text PRIMARY KEY, value jsonb NOT NULL);  -- data_version, dll.
```

**Estimasi volume:** per akun ±20 kampanye × 365 hari = 7.300 baris/tahun di `campaign_daily`, dan 8.760 baris/tahun di `account_hourly`. Totalnya sangat kecil, jadi query 90 hari cukup membaca beberapa ratus baris lewat index-only scan. Materialized view tidak diperlukan.

---

## 5. Sinkronisasi Meta

### 5.1 Panggilan API (semua `GET https://graph.facebook.com/{META_API_VERSION}/…` + `appsecret_proof`)

| Data | Endpoint & parameter |
|---|---|
| Info akun | `act_{id}?fields=name,currency,timezone_name,account_status` |
| Kampanye | `act_{id}/campaigns?fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time&limit=200` |
| Ad set (budget ABO) | `act_{id}/adsets?fields=id,campaign_id,status,daily_budget,lifetime_budget&limit=500` (hanya saat butuh scale) |
| Harian per kampanye | `act_{id}/insights?level=campaign&time_increment=1&time_range={"since":…,"until":…}&fields=campaign_id,spend,impressions,inline_link_clicks,actions,action_values&limit=500` |
| Per jam (akun) | `act_{id}/insights?level=account&time_increment=1&breakdowns=hourly_stats_aggregated_by_advertiser_time_zone&time_range=…&fields=spend,impressions,inline_link_clicks,actions&limit=500` |

**Pemetaan `actions`:**
- `purchases` = nilai `action_type == 'omni_purchase'` (fallback `offsite_conversion.fb_pixel_purchase`). Pakai satu saja supaya tidak dobel.
- `purchase_value` = `action_values` dengan tipe yang sama.
- `leads` = `action_type == ad_accounts.result_action_type` (untuk jasa).
- `spend` dari Meta berupa string desimal → `Math.round(Number(spend))` (IDR tanpa pecahan).

### 5.2 Jadwal (scheduler in-process, dikunci `pg_try_advisory_lock` supaya tidak dobel saat redeploy)

| Job | Kapan | Rentang |
|---|---|---|
| `recent` | tiap 30 mnt (06:00–24:00), tiap 2 jam (00:00–06:00) | kemarin + hari ini |
| `nightly` | 02:00 WIB | 28 hari terakhir (atribusi Meta masih bergerak) |
| `backfill` | sekali saat akun ditambahkan | 180 hari, dipecah per 30 hari |
| `manual` | tombol "Sinkron sekarang" (maks. 1x/5 mnt) | kemarin + hari ini |

### 5.3 Upsert batch (1 statement per halaman API)
```sql
INSERT INTO campaign_daily (campaign_id, date, account_id, spend, impressions, clicks, leads, purchases, purchase_value)
SELECT * FROM unnest($1::text[], $2::date[], $3::text[], $4::bigint[], $5::bigint[], $6::bigint[], $7::int[], $8::int[], $9::bigint[])
ON CONFLICT (campaign_id, date) DO UPDATE SET
  spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
  leads = EXCLUDED.leads, purchases = EXCLUDED.purchases, purchase_value = EXCLUDED.purchase_value,
  synced_at = now()
WHERE (campaign_daily.spend, campaign_daily.clicks, campaign_daily.purchases, campaign_daily.leads)
   IS DISTINCT FROM (EXCLUDED.spend, EXCLUDED.clicks, EXCLUDED.purchases, EXCLUDED.leads);
```
`data_version` hanya dinaikkan kalau ada baris yang berubah, supaya client tidak refetch tanpa alasan.

### 5.4 Rate limit & error
- Baca header `x-business-use-case-usage` / `x-ad-account-usage`. Kalau > 75%, tunda job berikutnya.
- Error 17/80004 (rate limit) → backoff 1, 2, 4, 8 mnt. Error 190 (token) → tandai integrasi "putus" dan kirim notif.
- Ukuran: ±4 panggilan per akun per sync → ±200 panggilan/hari untuk 2 akun, jauh di bawah batas.

### 5.5 Aksi ke Meta
| Aksi | Panggilan |
|---|---|
| Pause / Aktifkan | `POST /{campaign_id}` `status=PAUSED|ACTIVE` |
| Scale (CBO) | `POST /{campaign_id}` `daily_budget=round(before × (1+pct))` |
| Scale (ABO) | `POST /{adset_id}` `daily_budget=…` untuk tiap ad set aktif (batch request) |
| Batalkan aksi | Kembalikan `params.before` |

Sebelum eksekusi: ambil status/budget terbaru dari Meta (bukan dari DB) untuk `before`. Sesudah: perbarui `campaigns`, simpan `meta_response`.

---

## 6. Webhook lynk.id

**Endpoint:** `POST /webhooks/lynk` (publik, tanpa login, rate limit 60/mnt/IP, body maks. 64 KB).

**Contoh payload (dari dokumentasi resmi lynk.id):**
```json
{
  "event": "payment.received",
  "data": {
    "message_action": "SUCCESS",
    "message_code": "0",
    "message_data": {
      "createdAt": "2025-04-10T14:30:45",
      "customer": { "email": "user@lynk.id", "name": "Lynk User", "phone": "0812345677889" },
      "items": [{ "uuid": "63cfd869…-8244-36439", "title": "Digital Produk", "price": 25000, "qty": 1,
                  "addons": [{ "id": "…", "name": "Iniprodukaddon", "price": "50,000" }] }],
      "refId": "13f8d23beeb2aacbbc01c94060cc88d7",
      "totals": { "grandTotal": 72000, "totalPrice": 25000, "totalAddon": 50000, "convenienceFee": -3000,
                  "discount": 0, "affiliate": 0, "totalShipping": 0, "totalItem": 1 }
    },
    "message_id": "API_CALL_1744270275143115_4624014"
  }
}
```

**Langkah handler:**
1. Baca body mentah; parse JSON (gagal → 400).
2. `expected = sha256_hex(String(totals.grandTotal) + refId + message_id + LYNK_MERCHANT_KEY)`; bandingkan dengan header `X-Lynk-Signature` memakai `crypto.timingSafeEqual`.
3. `INSERT INTO lynk_events … ON CONFLICT (message_id) DO NOTHING RETURNING message_id`. Kalau tidak ada baris yang kembali (duplikat) → langsung 200.
4. Signature salah → simpan dengan `signature_ok=false`, balas **401**, catat warning (tidak diproses).
5. `message_action != 'SUCCESS'` → simpan saja, tidak membuat penjualan.
6. Dalam 1 transaksi: upsert `products` per `items[].uuid` (nama = `title`, harga = `price`, line = digital), lalu insert `sales` per item:
   - `revenue` dibagi proporsional dari `grandTotal` menurut `(price × qty + addon item)` supaya **Σ revenue = grandTotal** persis (sisa pembulatan masuk item terakhir).
   - `date` = tanggal WIB dari `createdAt` (asumsi waktu lokal WIB; dicek dengan transaksi asli).
   - `ON CONFLICT (lynk_ref_id, lynk_item_ix) DO NOTHING`.
7. Set `processed_at`, naikkan `data_version`, kirim SSE `{"type":"sale","amount":72000,"product":"…"}`.
8. Balas `200 {"ok":true}`. Target < 200 ms.

**Tes:** payload contoh di atas + key uji → signature dihitung di tes; kirim dua kali → 1 penjualan; signature salah → 401; item ganda → Σ revenue = grandTotal.

> Data pelanggan (nama/email/HP) hanya disimpan di `payload` mentah (dihapus otomatis setelah 180 hari), tidak ditampilkan di dashboard. Prinsip minimisasi data.

---

## 7. API (semua JSON, prefix `/api`, butuh sesi kecuali disebut)

Parameter umum: `acc=all|<accountId>|digital|jasa`, `from=YYYY-MM-DD`, `to=YYYY-MM-DD`. Server menghitung sendiri periode pembanding memakai `shared/dates.ts`.

| Method & path | Isi respons | Dipakai di |
|---|---|---|
| `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` | sesi | Login |
| `GET /bootstrap` | user, akun + settings, produk, `dataVersion`, status integrasi, `today` server | Sekali saat app dibuka |
| `GET /dashboard?acc&from&to` | `kpis` (sekarang + pembanding), `series` (harian atau per jam kalau 1 hari), `insights[]`, `revenueByLine`, `roasVsTarget` | Ringkasan |
| `GET /campaigns?acc&from&to` | baris kampanye + metrik + `rec` + total | Kampanye |
| `GET /hourly?acc&from&to` | 24 baris + `best5` + `worst5` | Per Jam |
| `GET /products?acc&from&to` | produk terlaris + total | Produk |
| `GET /pl?from&to` | per lini + gabungan + pembanding + unit economics + biaya lain | Laba Rugi |
| `GET /manual?limit=25&cursor=` | riwayat input (cursor `created_at,id`) | Laba Rugi |
| `POST /sales` · `DELETE /sales/:id` · `POST /sales/:id/restore` | input jasa (Zod; `revenue` boleh string "7,5jt" → `parseRp` di server juga) | Laba Rugi |
| `POST /costs` · `DELETE /costs/:id` · `POST /costs/:id/restore` | biaya lain | Laba Rugi |
| `GET /bot?acc&from&to&cursor=` | aturan + log aksi (paginasi) | Bot AI |
| `PATCH /accounts/:id/settings` | ubah aturan (owner) → log `update_rule` | Bot AI, chat |
| `PATCH /accounts/:id` | nama, line, result_action_type, bot_mode (owner) | Pengaturan |
| `CRUD /products`, `CRUD /fixed-costs`, `CRUD /users` | pengaturan (owner) | Pengaturan |
| `POST /chat` (stream SSE) | token teks + event `view` (pindah tampilan) + event `action_card` | Chat |
| `POST /actions` | buat aksi `pending` dari tombol tabel (owner) | Kampanye |
| `POST /actions/:id/confirm` · `/cancel` · `/revert` | eksekusi / batal / balikkan (owner) | Chat, Kampanye, Bot |
| `GET /events` (SSE) | `version`, `sale`, `sync`, `action` | Global |
| `POST /sync` | sinkron manual (owner, 1x/5 mnt) | Pengaturan |
| `GET /export/campaigns.csv?acc&from&to` | CSV streaming | Topbar |
| `GET /healthz` (publik) | `{ok, db, lastSyncAgeMin}` | Coolify |

### Contoh query inti (sekarang + pembanding dalam 1 kali scan)
```sql
-- $1 from, $2 to, $3 prevFrom, $4 prevTo, $5 account_ids text[]
SELECT account_id,
  sum(spend)          FILTER (WHERE date BETWEEN $1 AND $2) AS spend,
  sum(impressions)    FILTER (WHERE date BETWEEN $1 AND $2) AS impr,
  sum(clicks)         FILTER (WHERE date BETWEEN $1 AND $2) AS clicks,
  sum(leads)          FILTER (WHERE date BETWEEN $1 AND $2) AS leads,
  sum(purchases)      FILTER (WHERE date BETWEEN $1 AND $2) AS purchases,
  sum(purchase_value) FILTER (WHERE date BETWEEN $1 AND $2) AS meta_rev,
  sum(spend)          FILTER (WHERE date BETWEEN $3 AND $4) AS p_spend,
  sum(clicks)         FILTER (WHERE date BETWEEN $3 AND $4) AS p_clicks,
  sum(impressions)    FILTER (WHERE date BETWEEN $3 AND $4) AS p_impr,
  sum(leads)          FILTER (WHERE date BETWEEN $3 AND $4) AS p_leads
FROM campaign_daily
WHERE account_id = ANY($5) AND date BETWEEN LEAST($1,$3) AND GREATEST($2,$4)
GROUP BY account_id;
```
Pola yang sama untuk `sales` (dikelompokkan per `line`) dan `manual_costs`. Hasilnya beberapa baris saja, lalu `computeKpis()` di `shared/metrics.ts` menerapkan fee/PPN per akun dan biaya tetap prorata. **Tidak ada baris mentah yang dikirim ke browser.**

### Cache server
`key = route + params + dataVersion` → LRU 200 entri, TTL 60 dtk. Kalau `dataVersion` naik, entri lama otomatis tidak terpakai. Header `Cache-Control: private, max-age=0` + `ETag` (berbasis `dataVersion`), jadi request ulang bisa dijawab `304`.

---

## 8. Bot AI

### 8.1 Alur pesan
```
Input user
  └─► localRouter (client, ±0 ms)
        ├─ cocok "pindah akun/periode" saja → ubah URL state, balas lokal ("Oke, pindah ke Akun Jasa · Bulan lalu")
        ├─ cocok "ya/batal" & ada aksi pending → POST /actions/:id/confirm | cancel
        ├─ cocok "target roas N / batas cpa X / batas cpl X" → PATCH settings, balas lokal + Undo
        └─ selain itu → POST /api/chat (stream)
                          └─ Claude + tools → jawaban + (opsional) event view / action_card
```
Router lokal di-porting dari `localBot()` prototipe (regex akun, periode, aturan, kata ya/batal). Kalau sebuah kalimat berisi perpindahan tampilan **dan** pertanyaan ("roas digital minggu ini"), tampilan dipindah lokal dulu, lalu pertanyaannya dikirim ke backend dengan konteks baru.

### 8.2 Tools (didefinisikan di backend; semua baca data lewat query yang sama dengan dashboard)

| Tool | Input | Efek |
|---|---|---|
| `get_summary` | `account`, `preset` \| `from,to` | KPI + pembanding |
| `get_campaigns` | `account`, periode, `sort`, `limit` | daftar kampanye + rekomendasi |
| `get_hourly` | `account`, periode | jam terbaik/terburuk |
| `get_products` | `account`, periode | produk terlaris |
| `get_pl` | periode | laba rugi per lini |
| `set_view` | `account?`, `preset?` \| `from,to` | kirim event `view` ke UI |
| `update_rule` | `account`, `field` (targetRoas\|maxCpa\|maxCpl\|killAfterSpend\|scaleStepPct), `value` | langsung berlaku (tidak mengeluarkan uang), dicatat, bisa Undo |
| `propose_campaign_action` | `campaign_query` \| `campaign_id`, `action` (pause\|activate\|scale), `pct?` | **hanya membuat `bot_actions` status `pending`** + event `action_card`. Tidak memanggil Meta |

Tidak ada tool untuk mengeksekusi aksi. Eksekusi **hanya** lewat `POST /actions/:id/confirm` yang dipanggil tombol atau kata "ya" dari user (diproses router lokal, bukan model).

### 8.3 System prompt (inti)
- Peran: analis iklan untuk owner bisnis Produk Digital AI + Jasa AI. Bahasa santai ("gw/lo", sesuai prototipe), singkat, angka dulu baru penjelasan.
- Selalu sebut konteks akun dan periode. Uang dalam format `Rp1,2 jt`.
- Bedakan **ROAS riil** (lynk/manual) dan **ROAS Meta** (pixel).
- Aturan rekomendasi (tabel PRD F8) + nilai aturan akun saat ini disisipkan sebagai konteks.
- Jangan pernah mengaku sudah mengeksekusi aksi. Setelah `propose_campaign_action`, minta user menekan tombol konfirmasi.
- Kalau kampanye ambigu (lebih dari 1 cocok), tanya balik dengan daftar pilihan.

**Efisiensi:** system prompt + definisi tool diberi `cache_control` (prompt caching). History maks. 12 pesan terakhir. Konteks hanya angka agregat (< 2 KB). `max_tokens` 800. Rate limit 60 pesan/jam/user. Token dicatat di `chat_messages` untuk pantauan biaya.

### 8.4 Kartu aksi (UI)
```
┌─────────────────────────────────────────────┐
│ ⚡ Naikkan budget 20%                         │
│ BUNDLE | Broad | Purchase · Adv Habib …8768  │
│ Rp150.000 → Rp180.000 / hari                 │
│ Alasan: ROAS 3,4x ≥ 1,3 × target 2,5x         │
│ [ Ya, eksekusi ]   [ Batal ]     kedaluwarsa 9:41 │
└─────────────────────────────────────────────┘
```
Setelah sukses: "✓ Dieksekusi 14:32 · [Batalkan aksi]". Kalau gagal: pesan error Meta yang bisa dimengerti.

### 8.5 Rule engine / autopilot (P1)
- Jalan setelah job `recent` selesai. Jendela evaluasi = 3 hari terakhir (bukan hari ini saja).
- `suggest`: rekomendasi baru (berbeda dari evaluasi sebelumnya) dikirim sebagai notif WA ringkas + tautan ke dashboard.
- `auto`: Pause (aturan kill) dan Scale (aturan scale) dieksekusi langsung dengan pagar: maks. 1 aksi per kampanye per 6 jam, total kenaikan ≤ +50%/hari, budget ≤ `max_daily_budget`, kampanye umur < 3 hari dilewati, jam 00–06 tidak scale. Setiap aksi tercatat `source='rule_engine'` dan dikirim notif.

---

## 9. Desain UI (implementasi dari foto referensi)

### 9.1 Token (`apps/web/src/styles/tokens.css`)
```css
:root{
  --bg:#F4F5F7; --panel:#FFFFFF; --card:#FFFFFF; --line:#ECEDF1;
  --ink:#1D1F2C; --muted:#8A8FA3;
  --accent:#4F46E5; --accent-hover:#4338CA; --accent-soft:#EEF2FF; --nav-active-bg:#EEF2FF; --nav-active-ink:#1D1F2C;
  --yellow:#FFC21A; --yellow-soft:#FFF5D6;
  --green:#22A55B;  --green-soft:#E8F7EE;
  --red:#E5484D;    --red-soft:#FDECEC;
  --violet-a:#A855F7; --violet-b:#7C3AED; --pink:#D16BF2;
  --radius:16px; --shadow:0 1px 2px rgba(16,24,40,.04);
}
:root[data-theme="dark"]{
  --bg:#1B1C26; --panel:#21222D; --card:#272835; --line:#33354A;
  --ink:#F2F3F7; --muted:#9BA0B5;
  --accent:#818CF8; --accent-hover:#A5B4FC; --accent-soft:#2B2A4F; --nav-active-bg:#FFFFFF; --nav-active-ink:#1D1F2C;
  --yellow-soft:#3A3322; --green:#4ADE80; --green-soft:#1F3A2B; --red:#F87171; --red-soft:#3D2326;
  --shadow:none;
}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){ /* sama dengan blok dark */ } }
```

### 9.2 Komponen (memetakan referensi)

| Komponen | Spesifikasi |
|---|---|
| `Sidebar` | 240px, logo pinwheel + nama; item 40px, ikon 18px + label 14px, pill aktif radius 10px; pemisah garis; Pengaturan & Keluar; kartu "Tanya bot" + ilustrasi (SVG/WebP < 20 KB, lazy) di bawah |
| `Topbar` | Judul 26px weight 600; `PeriodPill` (ikon kalender, "1 Okt – 19 Okt 2026"); `AccountPill`; `ThemeToggle` (☀︎ switch ☾); avatar 32px + nama |
| `KpiCard` | padding 20px; label 13px redup; ikon outline kanan atas; nilai 30px weight 500 tabular; baris delta 12px "↑ 8,2% vs periode lalu" (hijau/merah) |
| `DonutCard` | donut tebal (cutout 62%), legenda bulat kecil di kiri bawah, angka total di atas |
| `RingCard` | ikon kiri atas, ring kecil 44px dengan % di kanan atas, label + nilai besar + sub "Periode ini" |
| `BarTrend` | bar tipis (barThickness 8–10, radius 999), track abu (gelap: track putih 10%), sumbu Y ringkas (`400k`) |
| `LineTrend` | garis halus `tension .4`, gradien ungu `--violet-a → --violet-b`, tanpa titik kecuali hover |
| `DataTable` | header 12px redup tanpa garis tebal; baris radius 10px dengan latar pastel sesuai rekomendasi; ≥ 768px tabel, < 768px `CardList` |
| `PeriodPicker` | popover (desktop) / bottom sheet (HP): daftar preset kiri, kalender 2 bulan kanan (1 bulan di HP), tombol ‹ › |
| `ChatPanel` | 400×620 kanan bawah (desktop), layar penuh (HP); bubble bot `--bg`, bubble user `--accent`; chip saran; `ActionCard` |
| `ConfirmDialog`, `Toast` (Undo), `Skeleton`, `EmptyState`, `ErrorState`, `SyncBanner` | — |

### 9.3 Tata letak per halaman (desktop ≥ 1280)
- **Ringkasan:** baris 1 = 4 KPI kecil (2×2) + Donut "Komposisi omzet" + Donut "Status kampanye"; baris 2 = KPI sisanya; baris 3 = `BarTrend` (2/4 lebar) + 2 `RingCard` (ROAS vs target, Laba vs lalu); baris 4 = `LineTrend` ROAS + kartu Insight bot (daftar baris pastel).
- **Kampanye:** filter status + cari nama, `DataTable` penuh.
- **Per Jam:** `BarTrend` + garis hasil, 2 tabel best/worst berdampingan.
- **Produk:** tabel + bar porsi; donut porsi per lini.
- **Laba Rugi:** 3 KPI laba; tabel L/R (2/3) + Angka kunci (1/3); 2 form berdampingan; riwayat.
- **Bot AI:** kartu aturan per akun (editable inline) + mode bot; log aksi (timeline).

---

## 10. Fase kerja & checklist

Estimasi untuk 1 developer full-time. Total **P0 ≈ 19 hari kerja (±4 minggu)**, P1 +4 hari.

### Fase 0 — Persiapan & akses (1 hari)
- [ ] F0.1 Owner menjawab 6 pertanyaan terbuka (PRD §13)
- [ ] F0.2 Buat Meta App + System User token (A1, A2); uji `GET act_1392053332395676?fields=name` dengan token
- [ ] F0.3 Anthropic API key + limit bulanan (A4)
- [ ] F0.4 Domain + DNS A record (A5)
- [ ] F0.5 Repo GitHub privat + akses GitHub App Coolify (A6); `git init` folder ini
- [ ] F0.6 Cek sisa resource VPS (`coolify_get_server_resources`), catat RAM/CPU bebas sebagai baseline

**Selesai kalau:** semua secret siap di password manager, token Meta berhasil membaca akun.

### Fase 1 — Fondasi (2 hari)
- [ ] F1.1 Monorepo pnpm (`apps/api`, `apps/web`, `packages/shared`), TS strict, ESLint, Prettier, Vitest
- [ ] F1.2 `docker-compose.dev.yml` Postgres 18; runner migrasi SQL sederhana (tabel `_migrations`)
- [ ] F1.3 Migrasi `0001_init.sql` (§4) + seed akun `1392053332395676` (digital) dan default settings
- [ ] F1.4 Porting `packages/shared` dari prototipe: `dates.ts`, `money.ts` (`parseRp`, `rp`, `rpk`), `metrics.ts`, `rules.ts` **+ unit test** (lihat §11)
- [ ] F1.5 Hono boot: env Zod, logger JSON, error handler, security headers, CSP, `/healthz`
- [ ] F1.6 Auth: argon2id, sesi DB, middleware `requireRole`, rate limit login, halaman Login; CLI `pnpm user:create`
- [ ] F1.7 Seed demo (porting `sampleDB()`) untuk 365 hari × 2 akun → dipakai dev & benchmark
- [ ] F1.8 Dockerfile multi-stage (build web + api → image `node:22-alpine`, non-root, ±120 MB)

**Selesai kalau:** `docker build` sukses, login berjalan, semua unit test shared hijau.

### Fase 2 — Ingest data (3 hari)
- [ ] F2.1 Meta client: fetch + paging + `appsecret_proof` + retry/backoff + baca header usage
- [ ] F2.2 Sync kampanye (metadata) + insights harian + per jam → upsert batch (§5.3)
- [ ] F2.3 Scheduler + advisory lock + `sync_runs`; job `recent`, `nightly`, `backfill`, `manual`
- [ ] F2.4 Backfill 180 hari akun digital; **verifikasi** total spend 30 hari vs MCP `ads_get_ad_entities` (harus ±Rp3,35 jt per 19 Okt, selisih ≤ 1%)
- [ ] F2.5 Webhook lynk.id (§6): signature, idempotensi, pembagian revenue per item, upsert produk
- [ ] F2.6 Tes webhook (payload contoh, duplikat, signature salah, multi-item)
- [ ] F2.7 `data_version` + SSE `/events`

**Selesai kalau:** data asli Meta ada di DB dan cocok dengan Ads Manager; webhook uji masuk tepat 1 kali.

### Fase 3 — API agregat + kerangka UI & design system (3 hari)
- [ ] F3.1 Query + route `/bootstrap`, `/dashboard`, `/campaigns`, `/hourly`, `/products`, `/pl` (§7)
- [ ] F3.2 Cache LRU + ETag; `EXPLAIN (ANALYZE, BUFFERS)` tiap query dengan seed 365 hari → simpan di `docs/perf.md`
- [ ] F3.3 Token CSS terang/gelap + font Inter self-host (subset latin, `font-display: swap`, preload 1 file)
- [ ] F3.4 Shell: `Sidebar`, `Topbar`, `BottomNav`, routing tab (URL state `acc/from/to` + hash tab), `ThemeToggle`
- [ ] F3.5 `PeriodPicker` (preset, kalender, ‹ ›, label pembanding) + `AccountPicker`
- [ ] F3.6 Komponen dasar: `KpiCard`, `Skeleton`, `EmptyState`, `ErrorState`, `Toast`, `ConfirmDialog`, `SyncBanner`
- [ ] F3.7 Wrapper Chart.js lazy (`import()` per jenis grafik), tema grafik membaca token CSS dan menggambar ulang saat tema berganti

**Selesai kalau:** shell responsif di 360–1440px, ganti tema mulus, ganti periode memanggil 1 request.

### Fase 4 — Halaman data (3 hari)
- [ ] F4.1 Ringkasan: 8 KPI + delta, `BarTrend` (harian/per jam otomatis), donut omzet per lini, ring ROAS vs target & laba vs lalu, insight bot
- [ ] F4.2 Kampanye: `DataTable` sortir + total + baris pastel + `CardList` mobile + aksi cepat (memanggil `POST /actions`, lalu `ConfirmDialog`)
- [ ] F4.3 Per Jam: grafik + best5/worst5
- [ ] F4.4 Produk & Jasa: tabel + bar porsi
- [ ] F4.5 Ekspor CSV (endpoint streaming) + stylesheet print untuk PDF
- [ ] F4.6 Invalidasi via SSE (debounce 2 dtk) + toast "Penjualan baru"

**Selesai kalau:** semua angka sama dengan hitungan prototipe untuk data seed yang sama (uji snapshot).

### Fase 5 — Laba Rugi & input manual (2 hari)
- [ ] F5.1 Kartu laba per lini + gabungan, tabel L/R 3 kolom, angka kunci, catatan biaya lain
- [ ] F5.2 Form penjualan jasa (pratinjau `parseRp`, saran nama jasa, HPP standar otomatis), optimistic update + rollback
- [ ] F5.3 Form biaya lain
- [ ] F5.4 Riwayat input (cursor pagination), hapus = soft delete + toast Undo 5 dtk
- [ ] F5.5 Pengaturan: akun, produk/jasa (harga, HPP), biaya tetap, pengguna, status integrasi + "Sinkron sekarang"

**Selesai kalau:** L/R bulan lalu dicek owner terhadap hitungan manual (omzet lynk selisih Rp0).

### Fase 6 — Bot AI (3 hari)
- [ ] F6.1 `localRouter.ts` (porting `localBot`) + unit test semua contoh perintah PRD
- [ ] F6.2 `/api/chat` streaming: Claude SDK, tools (§8.2), prompt caching, simpan `chat_messages`, rate limit
- [ ] F6.3 `propose_campaign_action`: fuzzy match nama kampanye (skor token seperti `findCampaign()` prototipe), tanya balik kalau ambigu, hitung before/after dari Meta live
- [ ] F6.4 `/actions/:id/confirm|cancel|revert`: eksekusi Meta (§5.5), kedaluwarsa 10 mnt, idempoten (konfirmasi dobel tidak eksekusi 2x)
- [ ] F6.5 `ChatPanel` + `ActionCard` + chip saran + event `view` memindah dashboard
- [ ] F6.6 Tab Bot AI: aturan editable inline + mode bot + log aksi (timeline, paginasi)
- [ ] F6.7 Uji di **kampanye uji** (budget minimum, dibuat khusus): pause → aktifkan → scale → revert

**Selesai kalau:** semua contoh perintah di PRD F8 menghasilkan perilaku yang benar; aksi tanpa konfirmasi mustahil.

### Fase 7 — Hardening, QA, deploy (2 hari)
- [ ] F7.1 Buat `iklan-db` di Coolify (Postgres 18-alpine, limit 256 MB, `shared_buffers=64MB`, backup harian 03:00, retensi 14)
- [ ] F7.2 Buat app `iklan-app` (Dockerfile, port 3000, healthcheck `/healthz`, limit RAM 384 MB / CPU 0,5, domain + SSL), isi env
- [ ] F7.3 Deploy → backfill → isi URL webhook `https://<domain>/webhooks/lynk` di dashboard lynk.id → transaksi uji asli
- [ ] F7.4 Lighthouse mobile & desktop; ukur bundle; benchmark API (autocannon) → isi tabel angka di `docs/perf.md`
- [ ] F7.5 QA responsif (360, 390, 768, 1024, 1440) × terang/gelap; aksesibilitas (axe)
- [ ] F7.6 Uji restore backup ke DB sementara
- [ ] F7.7 Serah terima: buat akun owner, panduan singkat 1 halaman, rekam layar demo

**Selesai kalau:** checklist Definition of Done PRD §14 tercentang semua.

### Fase 8 — P1 (4 hari, setelah rilis)
- [ ] F8.1 Rule engine `suggest` + notif WA via WAHA (rekomendasi baru, sync gagal 3x, token bermasalah)
- [ ] F8.2 Mode `auto` dengan pagar (§8.5) + laporan harian WA 08:00 ("Kemarin: laba Rp…, ROAS …, 2 aksi bot")
- [ ] F8.3 Saran jadwal tayang dari data per jam
- [ ] F8.4 PWA (manifest, ikon, service worker cache aset statis, Add to Home Screen)

### Backlog P2
Pemetaan produk ↔ kampanye via UTM lynk.id · drill-down ad set/iklan + thumbnail kreatif · target bulanan & proyeksi akhir bulan · multi-mata uang · laporan PDF otomatis mingguan.

### Linimasa

| Minggu | Fase | Hasil yang bisa dilihat owner |
|---|---|---|
| 1 | F0, F1, awal F2 | Login + data Meta asli mulai masuk |
| 2 | F2, F3 | Kerangka dashboard baru (gaya referensi) dengan periode & akun |
| 3 | F4, F5 | Semua tab berisi data asli, input jasa jalan, webhook lynk.id live di staging |
| 4 | F6, F7 | Bot AI + aksi iklan, deploy produksi, serah terima |
| 5 | F8 | Autopilot + notif WA + PWA |

---

## 11. Strategi pengujian

| Lapisan | Alat | Cakupan wajib |
|---|---|---|
| Unit `shared` | Vitest | `presetRange` semua preset (termasuk Senin sebagai awal minggu); `shiftRange` bulan kalender (31 Jan → Feb, kabisat 29 Feb, bulan berjalan dipotong ke hari ini); `compareRange`; `parseRp` (`7.500.000`, `7,5jt`, `750rb`, `500k`, `Rp 1.250.000`, `25 juta`, input kosong/sampah → 0); `computeKpis` (pembagian nol → 0/"—", rugi, tanpa pembanding); `recFor` semua cabang tabel aturan |
| Unit API | Vitest | signature lynk (vektor dari payload contoh), pembagian revenue per item (Σ = grandTotal), pemetaan `actions` Meta, kalkulasi before/after scale CBO & ABO |
| Integrasi | Vitest + Postgres (docker) | tiap endpoint dengan seed tetap → snapshot JSON; idempotensi webhook; konfirmasi aksi dobel; role admin ditolak untuk aksi |
| Kontrak Meta | rekaman respons (fixture) | parsing insights, paging, error 17/190 |
| E2E | Playwright (viewport 390×844 & 1440×900) | login → ganti periode → ‹ › → ganti akun → input jasa "7,5jt" → muncul di L/R → hapus + Undo → chat "laba bulan lalu" → "pause test kreatif" → kartu konfirmasi → Batal |
| Visual | screenshot Playwright terang/gelap | dibandingkan manual dengan foto referensi saat review |
| Performa | Lighthouse CI, `vite build --report`, autocannon, `EXPLAIN` | angka tercatat di `docs/perf.md` (target §12) |

---

## 12. Anggaran performa & cara ukur

| Item | Target | Cara ukur |
|---|---|---|
| JS awal (gzip) | ≤ 150 KB | `vite build` + `rollup-plugin-visualizer` |
| Chart.js | lazy, ≤ 70 KB gzip, hanya saat grafik terlihat | network tab |
| Font | 1 file Inter subset ≤ 35 KB woff2 | network tab |
| Request saat buka app | ≤ 3 (HTML, JS, `/bootstrap`) + 1 per tab | network tab |
| `/dashboard` 90 hari, akun "Semua" | p95 ≤ 150 ms (dingin), ≤ 10 ms (cache) | autocannon 50 req/dtk, seed 365 hari |
| Query agregat | ≤ 5 ms, Index Only Scan | `EXPLAIN (ANALYZE, BUFFERS)` |
| Webhook lynk | ≤ 200 ms | log durasi |
| RAM container | ≤ 200 MB rata-rata | Coolify metrics |
| LCP mobile (4G lambat) | ≤ 1,5 dtk | Lighthouse |
| CLS | ≤ 0,05 (skeleton berukuran tetap) | Lighthouse |

Setiap PR yang menyentuh query atau bundle harus mencantumkan angka sebelum/sesudah.

---

## 13. Deploy & operasional

### 13.1 Coolify (bisa dikerjakan lewat MCP `coolify` dari Claude Code)
1. `coolify_create_database` → type postgresql, image `postgres:18-alpine`, nama `iklan-db`, limit memori 256 MB.
2. `coolify_create_application` → sumber GitHub repo, build pack `dockerfile`, port 3000, domain, healthcheck `/healthz`, `limits_memory=384m`, `limits_cpus=0.5`.
3. `coolify_update_envs_bulk` → semua env (§2). Secret ditandai *is_secret*.
4. `coolify_create_database_backup` → harian 03:00, retensi 14.
5. Deploy → cek `coolify_get_logs` → jalankan `pnpm migrate` (otomatis saat boot, dikunci advisory lock).
6. DNS (`hostinger-dns`) A record → `76.13.193.138`.

### 13.2 Dockerfile (garis besar)
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/ ; COPY apps/web/package.json apps/web/ ; COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build && pnpm --filter api deploy --prod /out

FROM node:22-alpine
ENV NODE_ENV=production TZ=Asia/Jakarta
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /app/apps/web/dist ./public
COPY --from=build /app/db/migrations ./migrations
USER node
EXPOSE 3000
CMD ["node","dist/index.js"]
```

### 13.3 Pemantauan
- Coolify healthcheck + notifikasi bawaan Coolify.
- Halaman **Pengaturan → Status integrasi**: umur sync terakhir, webhook terakhir, token Meta (hasil `debug_token`), jumlah error 24 jam.
- Notif WA (P1): sync gagal 3x, webhook signature gagal ≥ 3x/jam, token bermasalah, aksi autopilot.
- Rotasi log: stdout (Coolify/Docker), `max-size 10m`.

### 13.4 Keamanan (checklist)
- [ ] Secret hanya di env Coolify; `.env` di `.gitignore`; tidak ada secret di bundle web (cek `grep` hasil build)
- [ ] `appsecret_proof` di semua panggilan Graph
- [ ] `timingSafeEqual` untuk signature
- [ ] CSP: `default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self' 'unsafe-inline'` (inline hanya untuk variabel tema)
- [ ] Cookie `__Host-sid; HttpOnly; Secure; SameSite=Lax`; CSRF: cek header `Origin` untuk method tulis
- [ ] Role check di server untuk semua aksi dan perubahan aturan (bukan hanya disembunyikan di UI)
- [ ] Escape semua teks dari Meta/lynk/Claude di UI (React default; tanpa `dangerouslySetInnerHTML`; markdown bot dirender dengan sanitasi)
- [ ] Rate limit: login, chat, webhook, sync manual
- [ ] Payload webhook > 180 hari dihapus job harian

---

## 14. Risiko teknis spesifik & langkah antisipasi

| Risiko | Antisipasi |
|---|---|
| `createdAt` lynk.id tanpa zona waktu | Verifikasi dengan 1 transaksi asli (bandingkan jam di dashboard lynk.id); fallback pakai `received_at` WIB kalau meragukan |
| Format `addons[].price` berupa string `"50,000"` (koma ribuan) | Parser khusus (hapus non-digit). Revenue tetap mengacu `grandTotal`, jadi aman |
| Signature memakai `grandTotal` sebagai string: `72000` vs `72000.0` | Pakai teks persis dari JSON mentah kalau angka; tes dengan transaksi asli; log kedua kandidat saat gagal (tanpa key) |
| Kampanye ABO dengan banyak ad set saat scale | Batch request Graph; tampilkan rincian per ad set di kartu konfirmasi |
| Nama kampanye mirip ("TIMELAPSE - …" ada 8 buah) | Fuzzy match wajib unik; kalau > 1 kandidat, bot menampilkan pilihan bernomor |
| Redeploy saat job sync berjalan | Advisory lock + upsert idempoten, jadi job berikutnya mengulang dengan aman |
| VPS penuh | Limit container; pantau; kalau perlu pindahkan ke VPS "baru" (Coolify kedua `coolify-baru` sudah ada) |

---

## Lampiran A — Pemetaan prototipe → produk

| Di `dashboard-ads.html` | Di produk |
|---|---|
| `sampleDB()` acak di browser | `db/seed/demo.ts` (dev saja) |
| `agg()` loop baris mentah di client | SQL `SUM … FILTER` di `apps/api/src/queries/*` + `shared/metrics.ts` |
| `presetRange/shiftRange/compareRange` | `packages/shared/dates.ts` (dipakai FE & BE) |
| `recFor()` | `packages/shared/rules.ts` |
| `parseRp/rp/rpk` | `packages/shared/money.ts` |
| `localStorage` input manual | tabel `sales` & `manual_costs` |
| `localBot()` | `apps/web/src/chat/localRouter.ts` (perintah sederhana) + Claude (sisanya) |
| `execAction()` (demo) | `POST /actions/:id/confirm` → Meta Graph API |
| `API.data / API.chat / API.manual` | endpoint per tab (§7) |
| Header + tab horizontal | Sidebar + topbar + bottom nav (gaya referensi) |

## Lampiran B — Data akun nyata saat perencanaan (19 Okt 2026, via MCP)
Akun digital `1392053332395676` ("Adv Habib Akbar-02 | 8768"), 30 hari terakhir, kampanye dengan spend tertinggi:
TIMELAPSE - 4 Konten Terbaik - Cost Cap 30.000 (Rp1.089.313) · Penjualan - 4 Post B (Rp591.929) · TIMELAPSE - 05 Oktober (Rp364.604) · E-book Gemini - Uji Pembelian (Rp216.856) · TIMELAPSE - ROAS Min 1.5 (Rp211.426) · … total 14 kampanye ±Rp3.354.066. Angka ini dipakai sebagai acuan verifikasi F2.4.
