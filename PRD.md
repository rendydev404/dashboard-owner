# PRD — Dashboard Iklan & Laba Rugi (Owner)

| | |
|---|---|
| **Versi** | 1.0 (draft) |
| **Tanggal** | 19 Oktober 2026 |
| **Pemilik produk** | Owner bisnis AI (Produk Digital AI + Jasa AI) |
| **Status** | Siap dikerjakan setelah 6 pertanyaan terbuka (§13) dijawab |
| **Dokumen terkait** | [PLANNING.md](PLANNING.md) · [reference/dashboard-ads.html](reference/dashboard-ads.html) (layout & logika) · [reference/design-reference.webp](reference/design-reference.webp) (gaya visual) |

---

## 1. Ringkasan

Dashboard internal untuk owner yang menyatukan **spend iklan Meta**, **omzet riil** (lynk.id otomatis + jasa input manual), dan **laba rugi per lini bisnis** dalam satu layar. Dashboard ini juga punya **bot AI** yang bisa ditanya angka, memindah tampilan, mengubah aturan, dan mengontrol iklan (pause/aktifkan/scale) dengan konfirmasi.

Prototipe `dashboard-ads.html` sudah membuktikan alur dan rumusnya, tapi masih **mode demo**: datanya dibuat acak di browser, semua agregasi dikerjakan di client, input manual hanya tersimpan di `localStorage`, dan bot hanya pencocokan kata kunci. PRD ini mengubahnya jadi produk nyata:

1. **Data asli:** Meta Marketing API (spend, klik, leads, pembelian, per jam) dan webhook lynk.id (penjualan produk digital).
2. **Backend + database di VPS** (Coolify, `76.13.193.138`). Agregasi dikerjakan di Postgres, bukan di browser.
3. **Bot AI asli** (Claude API + tool calling) yang bisa mengeksekusi aksi ke Meta Ads setelah dikonfirmasi.
4. **UI baru** mengikuti foto referensi (gaya "Business Analytics": sidebar kiri, kartu putih membulat, donut, ring progress, bar tipis, tema terang & gelap). Layout dan isi tetap mengikuti prototipe HTML.

---

## 2. Latar belakang & masalah

| Masalah sekarang | Dampak |
|---|---|
| ROAS di Ads Manager ≠ uang yang benar-benar masuk (atribusi pixel bisa lebih tinggi atau lebih rendah) | Keputusan scale/stop berdasarkan angka yang salah |
| Omzet jasa tidak tercatat di sistem mana pun | Laba bersih lini jasa tidak diketahui |
| Biaya di luar iklan (PPN iklan 3%, PPN lynk 3%, langganan tools, freelancer, refund) tidak dihitung | "Kelihatan untung" padahal rugi |
| Harus buka Ads Manager, dashboard lynk.id, dan spreadsheet satu per satu | Lambat, jarang dicek, telat ambil keputusan |
| Kontrol iklan harus manual di Ads Manager | Iklan boros sering telat dimatikan |

---

## 3. Tujuan & ukuran keberhasilan

### Tujuan
- **G1:** Owner tahu **laba bersih riil** per lini dan gabungan untuk periode apa pun dalam < 2 detik.
- **G2:** Setiap kampanye punya **rekomendasi** (Scale / Pertahankan / Ganti kreatif / Matikan) berdasarkan aturan yang bisa diatur sendiri.
- **G3:** Owner bisa **mengontrol iklan lewat chat** dengan aman (selalu ada konfirmasi, semua tercatat).
- **G4:** Penjualan lynk.id masuk **otomatis dalam hitungan detik** tanpa input manual.

### Metrik keberhasilan (target 30 hari setelah rilis)

| Metrik | Target |
|---|---|
| Waktu buka dashboard sampai KPI tampil (LCP, 4G) | ≤ 1,5 dtk |
| Respons API ringkasan (p95, periode 90 hari, akun "Semua") | ≤ 150 ms |
| Selisih omzet dashboard vs laporan lynk.id | 0 transaksi hilang (cek rekonsiliasi mingguan) |
| Keterlambatan data Meta | ≤ 30 menit (hari ini), final ≤ 24 jam |
| Webhook lynk.id diproses | ≥ 99,9%, ≤ 3 dtk sampai tampil |
| Aksi bot yang dieksekusi tanpa konfirmasi | 0 |
| Owner membuka dashboard | ≥ 5 hari/minggu |

### Bukan tujuan (out of scope v1)
- Membuat kampanye/iklan/kreatif baru dari dashboard (tetap di Ads Manager).
- Platform iklan selain Meta (TikTok/Google Ads).
- Multi-tenant atau dipakai klien luar.
- Aplikasi mobile native (cukup web responsif + bisa "Add to Home Screen").
- Akuntansi lengkap (pajak penghasilan, neraca). Fokusnya laba rugi operasional.

---

## 4. Pengguna

| Persona | Kebutuhan | Hak akses |
|---|---|---|
| **Owner** (utama) | Lihat laba, ambil keputusan scale/stop, kontrol bot | Semua, termasuk aksi iklan dan ubah aturan |
| **Admin/CS** (opsional) | Input penjualan jasa & biaya lain | Lihat dashboard, input/hapus input manual miliknya, **tidak bisa** aksi iklan atau ubah aturan |

Pemakaian: 70% dari HP (cek cepat pagi/malam), 30% desktop (evaluasi mingguan). Jadi **mobile harus kelas satu**, bukan versi sisa.

---

## 5. Kondisi sistem saat ini (hasil pengecekan 19 Okt 2026)

### 5.1 Meta Ads (lewat MCP di Claude Code)
Koneksi aktif. Akun yang bisa diakses:

| Ad account ID | Nama | Business | Status | Catatan |
|---|---|---|---|---|
| `1392053332395676` | Adv Habib Akbar-02 \| 8768 | DNR Media | ACTIVE | **Akun Produk Digital AI.** 14 kampanye dalam 30 hari terakhir (TIMELAPSE, E-book Gemini, Penjualan 4 Post), spend ±Rp3,35 jt |
| `1583638759594027` | Adv Habib Akbar-01 \| 7944 | DNR Media | ACTIVE | 3 kampanye ("Gas SS Kemitraan", "Kampanye Prospek Baru"), spend Rp0 dalam 30 hari |
| `3381276948791666` | (tanpa nama) | — | ACTIVE | — |
| `989422132112808` | Cpas Shopee | Susan Store | ACTIVE | Bukan bisnis AI |
| `483134997530010` | Suka Shawarma | Susan Store | UNSETTLED | Tidak bisa di-query |

Semua akun memakai mata uang **IDR**.

> ⚠️ **Temuan penting:** MCP Meta Ads yang terhubung ke Claude Code memakai login OAuth milik sesi Claude. **Backend dashboard di VPS tidak bisa memakai koneksi MCP itu.** Backend butuh **System User Access Token** sendiri dari Business Manager *DNR Media* (izin `ads_read` + `ads_management`) untuk memanggil Meta Marketing API langsung. MCP tetap berguna untuk analisis manual dan setup lewat Claude Code. Lihat PLANNING §2.

### 5.2 VPS `76.13.193.138`
- Hostinger **KVM 2**: 2 vCPU, 8 GB RAM, disk 100 GB, Ubuntu 24.04, hostname `srv1892441.hstgr.cloud`.
- Dikelola **Coolify** (proxy Traefik, SSL otomatis).
- Sudah menjalankan **±22 aplikasi** (keluarga `*.sukashawarma.com`: pos, hr, inventori, marcom, agents, dll.), Postgres `marcom-database`, Redis `suka-redis`, WAHA (WhatsApp API, `blast.sukashawarma.com`), dan n8n (status **exited**).
- **Konsekuensi:** resource sudah ramai. Aplikasi baru harus hemat: **1 container** (API + web statis + worker sinkron), target RAM ≤ 256 MB, plus 1 database Postgres terpisah yang kecil.

### 5.3 lynk.id
- Toko: `lynk.id/spbaicreator`.
- Webhook mengirim event `payment.received` (POST JSON) dengan header `X-Lynk-Signature`.
- Signature = `sha256_hex(grandTotal + refId + message_id + merchantKey)`.
- Merchant key sudah diberikan owner (`BaWg…C9iS`). Key ini **hanya disimpan sebagai env var di Coolify**, tidak ditulis di kode atau repo.

---

## 6. Ruang lingkup fitur

Prioritas: **P0** = wajib saat rilis, **P1** = rilis +1–2 minggu, **P2** = nanti.

### F1. Filter periode — P0
- Preset: Hari ini, Kemarin, 7 hari terakhir, Minggu ini, Minggu lalu, 30 hari terakhir, Bulan ini, Bulan lalu, 90 hari terakhir, **Custom** (pilih tanggal bebas di kalender).
- Tombol **‹ ›** menggeser periode dengan panjang yang sama. Kalau periodenya "satu bulan kalender" (mulai tanggal 1), geser per bulan kalender (contoh: Bulan lalu → klik ‹ → bulan sebelumnya penuh). Tombol › nonaktif kalau sudah sampai hari ini.
- **Periode pembanding otomatis:** bulan kalender → bulan sebelumnya dengan jumlah hari yang sama; selain itu → periode sebelumnya dengan panjang sama. Label "Dibanding 1–18 Sep 2026" selalu tampil.
- Setiap KPI menampilkan **▲/▼ % vs periode lalu**. Warnanya hijau kalau membaik dan merah kalau memburuk. Contoh: CPA turun = hijau.
- **Periode 1 hari** → grafik tren otomatis pindah ke **per jam**.
- Pilihan akun & periode terakhir diingat (per perangkat) dan ikut di URL (`?acc=…&from=…&to=…#tab`) supaya tautannya bisa dibagikan.
- Zona waktu: **Asia/Jakarta** untuk semua tanggal. Data Meta mengikuti zona waktu akun iklan; kalau berbeda, ditampilkan peringatan.

### F2. Pindah akun iklan — P0
- Pilihan: **Akun Produk Digital**, **Akun Jasa**, **Semua (gabungan)**. Daftar akun diambil dari tabel konfigurasi, jadi akun baru bisa ditambah tanpa ubah kode.
- Setiap akun punya **jenis lini**: `digital` atau `jasa`.
  - **Digital:** hasil = pembelian; KPI utama ROAS riil, CPA, AOV, CTR. Omzet dari lynk.id.
  - **Jasa:** hasil = leads (default: percakapan WhatsApp dimulai, bisa diatur per akun); KPI utama Leads, CPL, **closing rate**. Omzet dari input manual.
  - **Semua:** gabungan. KPI menyesuaikan (ada Leads + CTR kalau dua jenis digabung).
- Aturan rekomendasi bot berbeda per jenis (lihat F6).

### F3. Ringkasan (tab utama) — P0
- **8 kartu KPI:** Laba bersih (disorot), Omzet riil, Spend iklan (+PPN), ROAS riil (dengan titik impas), Leads/AOV, CPL/CTR, CPA (dengan CPA maks. impas), CTR/CPC. Komposisinya mengikuti logika prototipe.
- **Grafik tren:** bar spend vs omzet per hari + garis ROAS riil. Kalau 1 hari: per jam.
- **Insight bot otomatis** (maks. 5): untung/rugi, perbandingan periode, "Meta lapor lebih tinggi" (ROAS Meta vs riil selisih > 0,3), CPL jasa kemahalan, kampanye terbaik.
- **Donut "Komposisi omzet"** per lini (Digital vs Jasa), meniru kartu *Users* di referensi.
- **Ring progres** "ROAS riil vs target" dan "Laba vs periode lalu", meniru kartu *Paid Invoices / Funds received* di referensi.

### F4. Kampanye — P0
- Tabel per kampanye: Nama, Akun (kalau "Semua"), Status, Spend, Klik, CTR, Leads, CPL (jasa), Beli/closing, CPA, ROAS, **Rekomendasi bot**.
- Bisa diurutkan per kolom, ada baris total.
- Baris diberi warna pastel sesuai rekomendasi, meniru tabel *Customer order* di referensi: hijau = Scale, kuning = Ganti kreatif, merah = Matikan, netral = Pertahankan/Nonaktif.
- **Aksi cepat per baris** (khusus Owner): Pause / Aktifkan / Scale +X%. Semua lewat dialog konfirmasi yang sama dengan bot.
- Mobile: tabel berubah jadi **daftar kartu**, bukan tabel geser horizontal.

### F5. Per Jam — P0
- Grafik akumulasi per jam (bar spend + garis hasil) untuk periode terpilih.
- Tabel **5 jam paling cuan** (biaya per hasil terendah) dan **5 jam paling boros**.
- Dipakai bot untuk saran jadwal tayang (P1).

### F6. Produk & Jasa — P0
- Tabel produk terlaris: nama (link ke lynk.id), lini, harga, terjual, omzet, HPP, porsi (bar).
- Produk digital otomatis dibuat/dicocokkan dari webhook lynk.id (`items[].uuid` / `title`).
- Produk jasa diatur di Pengaturan (nama, harga standar, HPP standar).

### F7. Laba Rugi — P0
- **3 kartu:** Laba Produk Digital AI, Laba Jasa AI, Laba Gabungan (disorot). Masing-masing dengan ▲▼ vs periode lalu.
- **Tabel 3 kolom** (Produk Digital AI · Jasa AI · Gabungan). Baris:
  Penjualan → Fee platform → HPP/biaya pengerjaan → **Laba kotor** → Spend iklan → PPN iklan → Biaya operasional (prorata) → Biaya lain (input manual) → **Laba bersih** → Margin bersih → ROAS riil → Order/closing.
- Laba rugi **selalu menampilkan semua lini** (tidak ikut filter akun) dan diberi keterangan.
- **Angka kunci gabungan:** ROAS impas, ROAS riil, margin kotor, CPA maks. impas, CPA sekarang (incl. PPN), laba per order, closing rate, CPL.
- **Form Input penjualan jasa:** tanggal, akun jasa, jasa (pilih/ketik, ada saran), klien, sumber klien (Iklan/Organik/Referral), nilai deal, HPP (kosong = HPP standar jasa). Nominal bisa ditulis bebas: `7.500.000`, `7,5jt`, `750rb`, `25 juta`. Pratinjau angka tampil saat mengetik ("= Rp7.500.000").
- **Form Input biaya lain:** tanggal, lini, nama biaya, jumlah.
- **Riwayat input manual** (25 terakhir + "muat lagi"), bisa dihapus (soft delete) dengan konfirmasi dan **Undo 5 detik**.
- **Biaya operasional tetap** (langganan AI, server, gaji CS, dll.) diatur di Pengaturan dan dihitung prorata `bulanan × hari/30`.

### F8. Bot AI — P0 (chat & aksi), P1 (autopilot)
**Chat (tombol "Tanya bot" kanan bawah, plus kartu "Tanya bot" di sidebar, pengganti kartu "Need help" di referensi):**
- **Tanya angka:** "laba bulan lalu", "roas digital minggu ini", "jam paling cuan", "kampanye paling boros", "produk terlaris", "leads jasa kemarin".
- **Pindah tampilan:** "akun jasa", "semua akun bulan lalu". Dashboard ikut berubah.
- **Ubah aturan:** "target roas 3", "batas cpa 40rb", "batas cpl 60rb". Berlaku untuk akun yang sedang dipilih dan dicatat di log.
- **Kontrol iklan:** "pause test kreatif", "aktifkan retarget", "scale bundle", "rekomendasi". **Bot selalu minta konfirmasi** lewat kartu aksi berisi tombol **[Ya, eksekusi]** / **[Batal]** (mengetik "ya" juga bisa). Konfirmasi kedaluwarsa dalam 10 menit.
- Chip saran: "Laba bulan lalu?", "Rekomendasi", "Kampanye paling boros?", "Akun jasa minggu ini", "Jam paling cuan?", "Produk terlaris".
- Setiap jawaban diberi konteks: "Akun · periode".
- **Hybrid:** perintah sederhana (pindah akun/periode, ubah aturan berformat jelas) diproses lokal tanpa memanggil AI, jadi instan dan gratis. Pertanyaan/analisis lain dikirim ke Claude.

**Aturan rekomendasi (default, bisa diubah per akun):**

| Kondisi | Digital | Jasa |
|---|---|---|
| Kampanye tidak aktif | Nonaktif | Nonaktif |
| Spend ≥ `killAfterSpend` **dan** CPA > `maxCpa` (digital) / CPL > `maxCpl` (jasa) | **Matikan** | **Matikan** |
| ROAS ≥ `targetRoas × 1,3` | **Scale +scaleStep%** | **Scale +scaleStep%** |
| ROAS < target | Ganti kreatif | — |
| CPL > batas | — | Ganti kreatif |
| Lainnya | Pertahankan | Pertahankan |

Default digital: target ROAS 2,5 · batas CPA Rp45rb · matikan setelah spend Rp100rb · scale +20% · PPN iklan 3%.
Default jasa: target ROAS 4 · batas CPL Rp60rb · matikan setelah spend Rp300rb · scale +20% · PPN iklan 3%.
Periode 1 hari diberi label "sinyal awal".

**Tab Bot AI:** kartu aturan per akun (bisa diedit langsung, tidak hanya lewat chat), **log aksi bot** (siapa, kapan, apa, alasan, hasil API), dan mode bot per akun: **Mati / Saran saja / Autopilot**.

**Autopilot (P1):** setelah setiap sinkronisasi, mesin aturan mengevaluasi data 3 hari terakhir. Mode *Saran* kirim notifikasi (WhatsApp via WAHA yang sudah ada di VPS). Mode *Autopilot* mengeksekusi Pause/Scale sendiri dengan pagar pengaman: maks. +50% budget/hari/kampanye, jeda 6 jam antar aksi pada kampanye yang sama, tidak menyentuh kampanye fase learning < 3 hari, dan batas atas budget harian per akun.

### F9. Ekspor — P0
- **Unduh CSV** kampanye periode terpilih (UTF-8 BOM, aman dibuka Excel).
- **Unduh PDF** lewat cetak browser dengan stylesheet print yang rapi (semua panel tercetak, tanpa sidebar/chat).

### F10. Pengaturan — P0
- Akun iklan: nama tampilan, jenis lini, tipe hasil (purchase / lead / messaging), aktif tidak.
- Produk & jasa: harga, HPP standar, link.
- Biaya operasional tetap per lini.
- Pengguna & peran (Owner/Admin).
- Status integrasi: token Meta (berlaku sampai), sinkronisasi terakhir, webhook lynk.id terakhir diterima, tombol **"Sinkron sekarang"** (dibatasi 1x/5 menit).

### F11. Autentikasi — P0
- Login email + password (hash argon2id), sesi cookie `httpOnly; Secure; SameSite=Lax`, kedaluwarsa 30 hari (geser).
- Batas percobaan login: 5x/15 menit per IP.
- `noindex, nofollow`. Semua endpoint kecuali webhook dan healthz wajib login.

---

## 7. Alur utama (user flow)

### 7.1 Cek pagi dari HP
Buka PWA → (sesi tersimpan) Ringkasan "Kemarin" → lihat Laba bersih + ▲▼ → buka Kampanye → kartu merah "Matikan: Template Konten | Test Kreatif" → tap **Pause** → dialog konfirmasi → **Ya** → toast "Sudah di-pause" → masuk log.

### 7.2 Tanya bot
"roas digital minggu ini" → router lokal mendeteksi akun=digital dan periode=minggu ini, dashboard pindah → sisa pertanyaan ("roas") dijawab dari data agregat → "ROAS riil 2,84x, titik impas 1,52x."
"kenapa minggu ini lebih jelek?" → dikirim ke Claude bersama ringkasan agregat dan perbandingan → jawaban analisis.

### 7.3 Kontrol iklan via chat
"scale bundle" → Claude memanggil tool `propose_action(scale, campaign~"bundle")` → backend mencocokkan kampanye, menghitung budget baru (Rp150rb → Rp180rb), dan membuat `bot_actions` berstatus `pending` → chat menampilkan kartu "Naikkan budget **BUNDLE | Broad | Purchase** dari Rp150.000 ke Rp180.000/hari? [Ya, eksekusi] [Batal]" → Ya → backend memanggil Meta API → status `executed` → bot membalas "Beres" → log.

### 7.4 Penjualan lynk.id masuk
Pembeli bayar → lynk.id POST ke `/webhooks/lynk` → verifikasi signature → simpan event mentah (idempoten per `message_id`) → buat baris `sales` per item → balas 200 dalam < 200 ms → kirim event SSE "data berubah" ke dashboard yang terbuka → kartu Omzet/Laba terbarui sendiri (debounce 2 dtk) + toast kecil "Penjualan baru Rp149.000".

### 7.5 Input penjualan jasa
Laba Rugi → form → ketik "7,5jt" (pratinjau Rp7.500.000) → Simpan → muncul di riwayat dan tabel L/R langsung (optimistic update), rollback kalau gagal.

---

## 8. Definisi metrik (sumber kebenaran)

Semua uang dalam **Rupiah bulat (bigint)**. Untuk IDR, Meta tidak memakai pecahan.

| Metrik | Rumus |
|---|---|
| Omzet riil | Σ `sales.revenue` (lynk.id `totals.grandTotal` + jasa manual) |
| Fee platform / PPN lynk | **Omzet kotor** × `feePct` per lini (default digital **3%**). Omzet kotor = `totalPrice + totalAddon + totalShipping` (bukan `grandTotal`, yang sudah bersih dari diskon dan biaya layanan). Dihitung manual karena lynk tidak mengirim PPN |
| HPP | Σ `sales.cogs` (kosong → HPP standar produk × qty) |
| Laba kotor | Omzet − Fee − HPP |
| PPN iklan | Spend × `adTaxPct` (default **3%**, aturan owner di laporan hermes-ads) |
| Biaya tetap (prorata) | Σ biaya bulanan × jumlah hari periode / 30 |
| Biaya lain | Σ `manual_costs.amount` dalam periode (per lini) |
| **Laba bersih** | Laba kotor − Spend − PPN − Biaya tetap − Biaya lain |
| Margin bersih | Laba bersih / Omzet |
| ROAS riil | Omzet / Spend |
| ROAS Meta | `purchase_value` (pixel) / Spend, hanya untuk insight selisih |
| ROAS impas | (1 + tarif PPN) / (Laba kotor / Omzet) |
| CPA | (Spend + PPN) / Order |
| CPA maks. impas | (Laba kotor / Order) / (1 + tarif PPN) |
| CPL | Spend / Leads |
| Closing rate | Order jasa / Leads |
| CTR · CPC | Klik / Impresi · Spend / Klik |
| AOV | Omzet / Order |
| Δ% vs periode lalu | (sekarang − lalu) / \|lalu\|; tanpa pembanding → "—" |

> Catatan atribusi: lynk.id tidak tahu penjualan berasal dari kampanye mana. ROAS riil dihitung **per akun/lini**. ROAS per kampanye di tabel memakai nilai pixel Meta, diberi label "ROAS (Meta)". Pemetaan produk → kampanye lewat UTM bisa ditambah di P2.

---

## 9. Kebutuhan UI/UX (gaya mengikuti foto referensi)

### 9.1 Prinsip
Bersih, lega, sedikit garis. Angka besar mudah dibaca. Maksimal 1 warna aksen per kartu. Setiap layar menjawab satu pertanyaan.

### 9.2 Struktur (memetakan referensi ke isi dashboard)

| Elemen referensi | Dipakai untuk |
|---|---|
| Sidebar kiri: logo + menu dengan pill aktif | Logo + nama bisnis; menu = **Ringkasan, Kampanye, Per Jam, Produk & Jasa, Laba Rugi, Bot AI**; pemisah; **Pengaturan, Keluar** |
| Kartu "Need help / Get support" + ilustrasi | Kartu **"Butuh analisis? → Tanya bot"** (membuka chat) |
| Judul halaman "Analytics" + pill tanggal | Judul tab + **pill periode** (popover preset + kalender + ‹ ›) + **pill akun** |
| Toggle ☀︎ ● ☾ + avatar & nama | Toggle tema terang/gelap/sistem + avatar Owner (menu: profil, keluar) |
| Kartu kecil Orders/Approved/Month total/Revenue (ikon outline kanan atas, angka besar, ↑% hijau/↓% merah) | **8 kartu KPI** |
| Donut "Users" / "Subscriptions" + legenda | Komposisi omzet per lini · sumber klien jasa · status kampanye |
| Kartu "Paid Invoices / Funds received" + ring % | ROAS riil vs target · Laba vs periode lalu |
| "Sales dynamics" bar tipis membulat + pilihan tahun | Tren harian spend vs omzet (pilihan granularitas Harian/Mingguan/Bulanan) |
| "Overall User Activity" garis halus gradien ungu | Tren ROAS riil · per jam |
| Tabel "Customer order" dengan baris pastel & avatar | Tabel kampanye (warna = rekomendasi) · riwayat input manual |

### 9.3 Token desain

| Token | Terang | Gelap |
|---|---|---|
| Latar halaman | `#F4F5F7` | `#1B1C26` |
| Panel/sidebar | `#FFFFFF` | `#21222D` |
| Kartu | `#FFFFFF` | `#272835` |
| Garis | `#ECEDF1` | `#33354A` |
| Teks utama | `#1D1F2C` | `#F2F3F7` |
| Teks redup | `#8A8FA3` | `#9BA0B5` |
| **Aksen utama (indigo)** | `#4F46E5` (hover `#4338CA`) | `#818CF8` (hover `#A5B4FC`) |
| Indigo lembut (pill aktif, latar ikon) | `#EEF2FF` | `#FFFFFF` (pill aktif putih, teks gelap, seperti referensi) |
| Kuning (donut) | `#FFC21A` / lembut `#FFF5D6` | `#FFC21A` / `#3A3322` |
| Hijau (naik/ring) | `#22A55B` / `#E8F7EE` | `#4ADE80` / `#1F3A2B` |
| Merah (turun) | `#E5484D` / `#FDECEC` | `#F87171` / `#3D2326` |
| Ungu (garis gradien) | `#A855F7 → #7C3AED` | sama |
| Radius kartu / pill | 16px / 999px | sama |
| Bayangan kartu | `0 1px 2px rgba(16,24,40,.04)` | tanpa |

- **Font:** Inter (self-host, subset latin, weight 400/500/600), `font-variant-numeric: tabular-nums` untuk semua angka. Angka KPI 30–32px weight 500 (tipis seperti referensi), label 13px redup.
- **Ikon:** outline 1,5px (Lucide), 20px.
- **Baris tabel pastel gelap:** pakai versi redup (alpha 18%), bukan blok kuning/hijau/merah pekat seperti di foto, supaya teks tetap terbaca (kontras ≥ 4.5:1).
- Tema mengikuti sistem secara default dan bisa diganti manual (disimpan).

### 9.4 Responsif

| Lebar | Layout |
|---|---|
| ≥ 1280px | Sidebar penuh 240px, grid 4 kolom seperti referensi |
| 1024–1279 | Sidebar jadi rail ikon 76px (label muncul saat hover), grid 4 → 2+2 |
| 768–1023 | Sidebar jadi drawer (tombol ☰), grid 2 kolom |
| < 768 | **Bottom navigation** 5 ikon (Ringkasan, Kampanye, Laba Rugi, Bot, Lainnya), KPI 2 kolom kompak, tabel → kartu, popover periode → bottom sheet, chat layar penuh, FAB chat di atas bottom nav |

Tidak boleh ada scroll horizontal di level halaman. Target sentuh ≥ 44px. Gutter samping 16px di HP.

### 9.5 State wajib
Skeleton saat memuat (bukan spinner penuh), state kosong yang menjelaskan ("Belum ada penjualan di periode ini"), state error dengan tombol "Coba lagi", banner "Data Meta terakhir sinkron 14:30" (kuning kalau > 1 jam), indikator offline.

### 9.6 Aksesibilitas
Kontras WCAG AA, fokus keyboard terlihat, grafik punya ringkasan teks (`aria-label`) + tabel data alternatif, `prefers-reduced-motion` dihormati, semua tombol ikon punya label.

---

## 10. Kebutuhan non-fungsional

| Area | Kebutuhan |
|---|---|
| **Performa** | JS awal ≤ 150 KB gzip; Chart.js dimuat lazy per grafik; LCP ≤ 1,5 dtk; API agregat p95 ≤ 150 ms; 1 request per tab (endpoint gabungan), bukan banyak request kecil |
| **Efisiensi DB** | Semua agregasi di Postgres; kolom eksplisit (tanpa `SELECT *`); index sesuai filter `(account_id, date)`; tanpa N+1; paginasi `ORDER BY` unik; cek dengan `EXPLAIN (ANALYZE, BUFFERS)` |
| **Resource VPS** | 1 container app (limit RAM 384 MB, CPU 0,5), 1 Postgres kecil (`shared_buffers` 64 MB) |
| **Cache** | Cache respons di memori 60 dtk, kunci = versi data; versi naik saat sync/webhook/input → cache invalid. Client: React Query `staleTime` 60 dtk, `gcTime` 10 mnt, invalidasi via SSE |
| **Keamanan** | Token Meta, merchant key lynk, API key Claude hanya di env Coolify; verifikasi signature webhook (perbandingan waktu-konstan); rate limit login, chat, webhook; CSP ketat; header keamanan; audit log semua aksi & perubahan aturan |
| **Keandalan** | Webhook idempoten; sync Meta retry eksponensial + menghormati header rate-limit (`x-business-use-case-usage`); healthcheck `/healthz` di Coolify |
| **Data** | Backup Postgres harian (retensi 14 hari) lewat Coolify; payload webhook mentah disimpan 180 hari |
| **Observabilitas** | Log JSON terstruktur; tabel `sync_runs`; halaman status integrasi; notifikasi WA ke owner kalau sync gagal 3x berturut-turut atau token hampir kedaluwarsa |
| **Lokalisasi** | Bahasa Indonesia; format `Rp1.234.567`, singkat `Rp1,2 jt` / `Rp450 rb`; tanggal `19 Okt 2026` |

---

## 11. Integrasi

| Sistem | Arah | Cara | Frekuensi |
|---|---|---|---|
| Meta Marketing API (Graph v2x.0) | Tarik insights + kirim aksi | System User token | Hari ini & kemarin tiap 30 mnt; 28 hari terakhir tiap malam 02:00 WIB (atribusi berubah); backfill 180 hari sekali saat awal |
| lynk.id | Push | Webhook `POST /webhooks/lynk` | Real-time |
| Claude API | Chat + tool calling | `ANTHROPIC_API_KEY`, model `claude-sonnet-5-5`, prompt caching untuk system prompt + definisi tool | Per pesan |
| WAHA (sudah ada di VPS) | Notifikasi keluar (P1) | HTTP API internal | Saat ada event |

---

## 12. Risiko & mitigasi

| Risiko | Kemungkinan | Dampak | Mitigasi |
|---|---|---|---|
| Token Meta kedaluwarsa/dicabut | Sedang | Data berhenti | System User token (tanpa kedaluwarsa), cek harian `debug_token`, notifikasi WA |
| Rate limit Meta | Rendah | Sync telat | Panggilan sedikit (level campaign, `time_increment=1`), async report untuk backfill, baca header usage |
| Format webhook lynk.id berubah / signature tidak cocok | Sedang | Penjualan tidak masuk | Simpan semua payload mentah meski signature gagal (ditandai), alert, tombol "proses ulang" |
| Bot salah mengeksekusi kampanye | Rendah | Uang terbuang | Wajib konfirmasi dengan nama kampanye dan angka sebelum→sesudah, guardrail, log + tombol "Batalkan aksi" (balik status/budget sebelumnya) |
| VPS kehabisan RAM (22+ app) | Sedang | Semua app lambat | Limit resource container, worker in-process ringan, pantau `get_server_resources` |
| Biaya Claude API membengkak | Rendah | Biaya | Router lokal untuk perintah sederhana, prompt caching, konteks hanya angka agregat, batas 60 pesan/jam |
| ROAS per kampanye ≠ riil | Pasti | Salah tafsir | Label jelas "ROAS (Meta)" vs "ROAS riil", insight selisih |

---

## 13. Pertanyaan terbuka (perlu jawaban owner)

1. **Akun Jasa AI** yang mana? Hanya `…8768` yang jelas digital. Akun `…7944` berisi kampanye "Gas SS Kemitraan" (sepertinya Suka Shawarma, bukan jasa AI). Apakah akun jasa belum dibuat, atau memakai akun lain?
2. **Domain/subdomain** dashboard? (Usulan: `iklan.<domain-bisnis-AI>`, atau sementara `iklan.sukashawarma.com`.)
3. **System User token Meta:** owner bisa membuatkannya di Business Manager *DNR Media*, atau mau dipandu langkah demi langkah?
4. **Hasil jasa = apa?** Percakapan WhatsApp dimulai (Click-to-WA) atau Lead Form? Ini menentukan `action_type` yang dihitung sebagai "leads".
5. ~~Fee lynk.id~~ **Terjawab** lewat project hermes-ads: omzet riil = `grandTotal`; PPN lynk 3% dihitung manual dari omzet kotor (`totalPrice + totalAddon + totalShipping`); PPN iklan 3% dari spend.
6. **Notifikasi WhatsApp** lewat WAHA (`blast.sukashawarma.com`) boleh dipakai untuk alert dashboard ini? Ke nomor siapa?

Asumsi sementara yang dipakai di PLANNING: (1) akun jasa dikonfigurasi belakangan lewat Pengaturan, (2) domain menyusul (pakai sslip.io dulu), (4) leads = `onsite_conversion.messaging_conversation_started_7d`, (5) sudah ditetapkan dari aturan hermes-ads (lihat di atas).

---

## 14. Kriteria rilis (Definition of Done v1)

- [ ] Semua fitur P0 berjalan dengan **data asli** (Meta + lynk.id), bukan data contoh.
- [ ] Angka laba rugi bulan lalu cocok dengan hitungan manual owner (selisih Rp0 untuk omzet lynk.id, ≤ 1% untuk spend Meta).
- [ ] Webhook lynk.id teruji dengan transaksi asli + uji signature salah ditolak (401).
- [ ] Aksi Pause/Aktifkan/Scale teruji di 1 kampanye uji dan tercatat di log. Tanpa konfirmasi tidak bisa jalan.
- [ ] Lighthouse mobile: Performance ≥ 90, Accessibility ≥ 95.
- [ ] Lolos QA di 360px, 390px, 768px, 1024px, 1440px, tema terang & gelap.
- [ ] Angka performa nyata dilaporkan (ms API, KB bundle, jumlah request per tab).
- [ ] Backup DB harian aktif dan restore pernah diuji.
