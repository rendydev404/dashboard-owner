# Lanjutan: Konten Iklan Otomatis (Remotion + ElevenLabs)

Dokumen serah-terima untuk melanjutkan [PLAN-konten-otomatis.md](PLAN-konten-otomatis.md).
Terakhir diperbarui: 23 Okt 2026 · Status: **Fase 0 berjalan, uji 0.6 lulus di 720×1280; sisanya menunggu login ElevenLabs**

## 1. Ringkasan satu menit

- Template video iklan 9:16 (Remotion) **sudah jadi dan berjalan** di laptop: video 27 dtk dirender dalam 51 detik.
- Di VPS 3 render **lulus pada 720×1280**: video 27 dtk selesai dalam 111 detik, RAM puncak 1.506 MB (batas 1.536 MB).
  Render 1080×1920 butuh ±1,9 GB, jadi worker memakai `RENDER_SCALE=2/3` sebagai bawaan. Marjin RAM tipis (±30 MB), lihat §4.
- ElevenLabs **belum login** di VPS (uji 0.1–0.5 menunggu owner), jadi suara masih nada pengganti.
- Semua pekerjaan ini **belum di-commit dan belum di-push**. Tidak ada yang berubah di produksi.

## 1a. Fase 1 sudah dibangun (23 Okt 2026)

Alur: owner minta video di chat (dengan 1–6 foto/video lampiran) → Claude menulis hook, naskah, copy, dan rencana kampanye →
tool `create_video_ad` → worker merender (suara + subtitle + template) → QC → **kartu pratinjau di chat** →
owner menonton lalu tekan **Setujui & iklankan** → video diupload ke Meta, ditunggu sampai diproses → kampanye dibuat
lewat alur launch yang sudah ada dan **langsung tayang** (atau draft kalau rencananya `startNow: false`). Tombol **Buang** membuang video.
Tidak ada yang menyentuh Meta sebelum owner menyetujui.

| Bagian | File |
|---|---|
| Worker HTTP + antrean 1-per-1 + QC teknis + cover | `apps/creative-worker/src/server.ts`, `jobs.ts` |
| Suara: ElevenLabs REST *with-timestamps* (API key); tanpa key = tanpa suara, subtitle berwaktu perkiraan | `apps/creative-worker/src/voice.ts` |
| Run, validasi harga vs data produk, batas 5/minggu/akun, persetujuan → upload → launch | `apps/api/src/creative.ts` |
| Tool bot + aturan di prompt | `apps/api/src/bot.ts` (`create_video_ad`) |
| Rute `/api/creative/:id` (+ `/approve`, `/discard`, `/video` dengan Range, `/cover`) | `apps/api/src/app.ts` |
| Tabel metadata | `db/migrations/0003_creative_runs.sql` |
| Kartu video di chat (polling hanya selama proses berjalan) | `apps/web/src/chat/VideoCard.tsx` |

Diuji di lokal (DB dev + worker): render 15 dtk selesai 36 dtk, QC lolos, video bisa diputar & di-seek, harga karangan ditolak,
persetujuan ganda ditolak (409), tanpa login ditolak (401). Langkah upload & launch ke Meta **belum diuji sungguhan**
karena Meta MCP tidak tersambung di laptop. Uji pertama di produksi sebaiknya dengan `startNow: false` (draft).

**Mengaktifkan suara ElevenLabs** (jalur REST, tidak perlu login MCP): buat API key di elevenlabs.io → Profile → API Keys,
pilih Voice ID Bahasa Indonesia, lalu di VPS 3 tambahkan ke `/etc/creative-worker.env` dan jalankan ulang container:
```
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
```
Catatan lisensi: paket gratis ElevenLabs tidak untuk penggunaan komersial (iklan). Untuk iklan yang tayang, pakai paket berbayar.

**Status 23 Okt:** API key sudah terpasang di `/etc/creative-worker.env`. Paket gratis **tidak bisa memakai suara Voice Library
lewat API** (HTTP 402 `paid_plan_required`), termasuk dua suara Indonesia di akun (Ghaisan `vLsH4ENK3zGpAuW1lSh4`,
Zan `zmqLb9Ysr8fUvDD7hXK8`). Sementara dipakai suara bawaan **Liam** (`TX3LPaxmHKxFdv7VOQHJ`, multibahasa, logat bisa terdengar asing).
Uji produksi: naskah 167 karakter → video 14,1 dtk dalam 64 dtk, audio AAC, QC lolos, RAM puncak 1.393 MB.
Setelah upgrade ke paket berbayar, ganti `ELEVENLABS_VOICE_ID` ke Ghaisan lalu jalankan ulang container. API key ini tidak punya
izin `user_read`, jadi sisa kredit tidak terbaca dari server (cek di elevenlabs.io).

**Yang tidak disimpan setelah restart server dashboard:** file video ada di penyimpanan lampiran sementara (memori proses + disk),
jadi run yang menunggu review ditandai `expired` saat server start dan harus dibuat ulang.

## 2. Status uji Fase 0

| # | Uji | Status | Catatan |
|---|---|---|---|
| 0.1 | Login MCP ElevenLabs di VPS | ⏳ Menunggu owner | `claude mcp list` di VPS hanya menampilkan Claude Docs & meta_ads |
| 0.2 | Daftar tool MCP | ⏳ Terblokir 0.1 | |
| 0.3 | TTS Bahasa Indonesia bisa diunduh server | ⏳ Terblokir 0.1 | |
| 0.4 | Cap waktu per kata | ⏳ Terblokir 0.1 | Konversi cap waktu karakter → kata sudah siap (`wordsFromAlignment`, teruji) |
| 0.5 | Umur token OAuth ElevenLabs | ⏳ Terblokir 0.1 | Login MCP hanya menyimpan access token tanpa refresh token |
| 0.6 | Render 20 dtk di VPS 3, ≤ 3 menit & ≤ 1,5 GB | ✅ Lulus di 720p | 27 dtk video → 111 dtk, puncak 1.506 MB. 1080p gagal (OOM). Lihat §4 |
| 0.7 | Kuota gratis per video | ⏳ Terblokir 0.1 | |

## 3. Yang sudah dibuat (semua lokal, belum di-commit)

Folder baru [`apps/creative-worker/`](../apps/creative-worker):

| File | Fungsi |
|---|---|
| `src/schema.ts` | Kontrak props video (zod): hook, poin, harga, CTA, kata+cap waktu, adegan, warna merek. Batas panjang teks. |
| `src/captions.ts` | Pengelompokan subtitle (maks 4 kata/20 karakter, pisah di tanda baca & jeda), kata aktif, `wordsFromAlignment`. |
| `src/AdVideo.tsx` | Template: hook animasi, poin, subtitle sorot per kata, badge harga, logo, kartu penutup CTA. Zona aman Reels/TikTok. |
| `src/Root.tsx`, `src/remotion-entry.ts` | Pendaftaran komposisi `Ad` (1080×1920, 30 fps, durasi dari props). |
| `src/render.ts` | `renderAd()` & `renderFrame()`. Port bebas acak, concurrency dibatasi core terlihat, cache video dibatasi, bundle prabangun. |
| `src/build-bundle.ts` | Membangun bundle Remotion sekali (saat build image). |
| `src/assets-server.ts` | Server file 127.0.0.1 dengan dukungan Range, untuk foto/video/audio sementara. |
| `src/sample.ts` | Uji render: video contoh dari aset + suara nada sintetis + cap waktu perkiraan. |
| `Dockerfile`, `.dockerignore`, `.gitignore` | Image worker (Debian + Chrome headless + font Noto). |
| `test/*.test.ts` | 18 tes: subtitle, kontrak props, server aset (Range, anti keluar folder), concurrency. **Semua lulus**, typecheck bersih. Sesekali 1 tes gagal di jalan pertama (start dingin, kemungkinan timeout); jalan ulang selalu lulus. |

Perubahan lain di repo: `pnpm-lock.yaml` (dependensi Remotion 4.0.537 dipatok persis), `docs/PLAN-konten-otomatis.md` (belum di-track git).
Dashboard & API **tidak disentuh**.

## 4. Hasil uji render

### Laptop (Windows, mode bawaan)
- Video 27,41 dtk, 55 kata, 822 frame → **render 50,8 dtk (16 fps)**, bundle 2 dtk, file 9,29 MB, RSS node 650 MB.
- Tampilan sudah dicek lewat 4 frame contoh (hook, poin+subtitle, badge harga, kartu penutup): terbaca dan rapi.
- Catatan: port 3000 di laptop dipakai proyek BotThreads → Remotion salah mengira itu servernya. Sudah diatasi dengan port acak.

### VPS 3 (2 core, container `--memory=1536m --cpus=1.5`)
| Percobaan | Hasil | Pelajaran |
|---|---|---|
| 1 | Gagal: `Maximum for --concurrency is 1` | Container `--cpus=1.5` terbaca **1 core** → concurrency dibatasi otomatis (`pickConcurrency`). |
| 2 | RAM puncak **1.270 MB** sebelum render dimulai | Bundling webpack >1 GB. → bundle dibuat **saat build image** (`BUNDLE_DIR`). |
| 3 | **Chrome crash (OOM)**, RAM menyentuh 1.536 MB, CPU ter-throttle 94× | Dugaan kuat: cache pembaca video Remotion (bawaan ±50% RAM yang *terlihat* = RAM server, bukan batas container). → dibatasi `VIDEO_CACHE_MB=200`. |
| 4 | 1080p, batas **3 GB**: selesai, render 159,4 dtk (5,2 fps), 7,47 MB, **puncak 1.909 MB** | Semua perbaikan bekerja, tapi 1080p memang butuh >1,5 GB. |
| 5 | 1080p, batas 1,5 GB: **Chrome crash setelah 48 dtk** | Kebutuhan RAM nyata, bukan sekadar cache file. |
| 6 | 720p (`RENDER_SCALE=0.667`): gagal seketika | Remotion menolak tinggi tidak bulat (1279,97). → skala ditulis pecahan `2/3`. |
| 7 | **720p (`RENDER_SCALE=2/3`), batas 1,5 GB: LULUS**: render 108,8 dtk (7,6 fps), total 111 dtk, 4,82 MB, **puncak 1.506 MB** | Bawaan Dockerfile sekarang `RENDER_SCALE=2/3`. |

Uji 23 Okt dilakukan dengan image yang dibangun ulang dari nol (image & cache build lama sudah terhapus dari VPS, disk kini 17%).
Load VPS saat uji: 0,7 → 4 (render memakai 1,5 core penuh).

**Uji marjin (23 Okt, semua 720p, video 27 dtk):**

| Setelan | Render | Total | Puncak RAM | Sisa terhadap batas |
|---|---|---|---|---|
| batas 1,5 GB, `VIDEO_CACHE_MB=200` | 108,8 dtk | 111 dtk | 1.506 MB | 30 MB (2%) |
| **batas 1,5 GB, `VIDEO_CACHE_MB=100`** | **101,0 dtk** | **104 dtk** | **1.409 MB** | **127 MB (8%)** |
| batas 2 GB, `VIDEO_CACHE_MB=200` | 109,4 dtk | 112 dtk | 1.486 MB | 562 MB |

Kebutuhan nyata ±1,4–1,5 GB. `VIDEO_CACHE_MB=100` sekarang jadi bawaan (Dockerfile & `render.ts`): lebih hemat dan sedikit lebih cepat.
**Keputusan owner (23 Okt): container worker produksi `--memory=2g --memory-swap=2g --cpus=1.5`, `VIDEO_CACHE_MB=100`, 720p.**
Batas itu atap, bukan jatah: saat diam worker ±200 MB, saat render ±1,4 GB. Pengaman yang wajib ikut dibangun bersama worker:
antrean satu render sekali jalan, durasi iklan maks. 45 dtk, klip sumber diperkecil ke ≤1080p sebelum render, catat puncak RAM tiap render.

**Swap VPS 3 (23 Okt):** `/swapfile` 10 GB, terdaftar di `/etc/fstab` (unit `swapfile.swap` aktif, teruji `swapoff`/`swapon -a`),
`vm.swappiness=10` & `vm.vfs_cache_pressure=50` di `/etc/sysctl.d/99-swap.conf`. Swap ini cadangan darurat untuk seluruh server;
container worker sengaja tidak boleh memakai swap (`--memory-swap` = `--memory`), karena render di swap jauh lebih lambat daripada gagal lalu diulang. Catatan: image `creative-worker-test` di VPS masih berisi `render.ts` lama;
uji 720p memasang versi baru lewat `-v /tmp/cw-render.ts:...`. Bangun ulang image sebelum deploy.

## 5. Langkah berikutnya (urut)

### A. ~~Selesaikan uji 0.6 (render di VPS 3)~~ ✅ lulus 23 Okt di 720p (lihat §4); tinggal pilih marjin RAM untuk produksi
Langkah di bawah disimpan sebagai acuan bila perlu mengukur ulang.
1. Tunggu load VPS turun (`uptime` < 1,2). Jalankan di luar jam ramai.
2. Ukur kebutuhan sebenarnya dulu dengan batas longgar (3 GB), lihat `MEM_PEAK_MB`:
   ```bash
   ssh vps3 'rm -f /tmp/cw-out/*; docker run --rm --memory=3g --memory-swap=3g --cpus=1.5 --shm-size=256m -v /tmp/cw-assets:/assets -v /tmp/cw-out:/out creative-worker-test sh -c "npx tsx src/sample.ts --assets /assets --out /out --stills 2>&1 | tail -8; echo MEM_PEAK_MB=\$(( \$(cat /sys/fs/cgroup/memory.peak) / 1048576 ))"'
   ```
3. Ulangi dengan `--memory=1536m`. Lulus kalau: selesai ≤ 3 menit dan puncak ≤ 1,5 GB.
4. Bila masih melebihi 1,5 GB, urutan opsi (dari yang paling murah):
   - render **720×1280** (`scale` 0,667; Meta menerima ≥ 600 px lebar) → piksel ±44% lebih sedikit;
   - ganti `RENDER_GL` dari `swangle` ke `angle`;
   - perkecil `VIDEO_CACHE_MB` (mis. 100) atau pakai adegan foto saja (tanpa `OffthreadVideo`);
   - naikkan batas ke 2 GB bila RAM server masih longgar (saat ini ±4 GB tersedia, tapi dipakai app lain);
   - **render di server lain** (VPS Hostinger ke-1/ke-2, atau server Coolify kedua) dan hanya mengirim MP4 ke dashboard.
5. Catat hasilnya di §2 baris 0.6 dan bersihkan sisa uji (§7).

### B. Login ElevenLabs (butuh owner)
Hanya bisa dilakukan owner karena butuh login lewat browser:
```bash
ssh vps3
sudo -u claude-ads -i claude mcp add --transport http elevenlabs https://api.elevenlabs.io/v1/mcp
sudo -u claude-ads -i claude      # lalu ketik /mcp → elevenlabs → Authenticate → /exit
sudo -u claude-ads -i claude mcp list    # harus menampilkan elevenlabs ✔ Connected
```
Setelah itu: uji 0.2–0.5 (daftar tool, TTS Indonesia, cap waktu, umur token), pilih jalur pemanggilan sesuai tabel di PLAN §3.

### C. ~~Setelah Fase 0 lulus~~ ✅ dibangun 23 Okt (lihat §1a)
Yang belum: QC kebijakan oleh Claude atas 4 frame (PLAN §4.4, sekarang hanya aturan di prompt), penghentian otomatis kalau Meta
menolak ≥ 2 iklan/7 hari (PLAN §4.5), dan pengecilan otomatis klip >1080p (sekarang ditolak dengan pesan).

## 6. Yang perlu diputuskan / disiapkan owner

1. **Login MCP ElevenLabs** (langkah B).
2. Pilih **suara Bahasa Indonesia** di ElevenLabs.
3. **Aset merek**: logo PNG transparan, 2 warna utama, 5–10 klip/foto contoh hasil.
4. Akun target Fase 1 (saran: Adv Habib Akbar-02).
5. Jumlah karyawan, untuk lisensi Remotion (gratis ≤ 3 karyawan).
6. **Aturan yang hilang dari PLAN:** versi terbaru file PLAN tidak lagi memuat §4.1 (lisensi) dan §4.2 (kuota & biaya),
   padahal §4.5 masih merujuk "§4.1". Poin yang paling penting: **ElevenLabs gratis tidak punya lisensi komersial**
   dan mewajibkan atribusi, jadi iklan bersuara ElevenLabs paket gratis sebaiknya hanya **draft**. Mohon konfirmasi apakah
   penghapusan itu disengaja. Fase 1 tetap draft-only, jadi tidak menghalangi pembangunan.

## 7. Sisa uji yang perlu dibersihkan

Di **VPS 3** (belum dihapus; per 23 Okt disk 17% terpakai, plus `/tmp/cw-render.ts` yang dipasang ke container saat uji 720p):
```bash
ssh vps3 'docker image rm creative-worker-test; rm -rf /tmp/cw-assets /tmp/cw-out /tmp/cw-render.ts /root/cw-context.tgz; docker image ls | grep creative'
```
Image menambah ±1,8 GB, ditambah cache build yang bisa dilihat dengan `docker builder du`.

Di **laptop**: dev server dashboard masih berjalan di tab terminal (database `:54329`, API `:3001`, web `:5173`) dan bisa dimatikan.
Folder `.sample-assets/` dan `.sample-out/` di `apps/creative-worker/` sudah di-ignore git (berisi foto/video contoh akun sendiri).

## 8. Cara melanjutkan di laptop

```bash
pnpm install
pnpm --filter @iklan/creative-worker test          # 18 tes
pnpm --filter @iklan/creative-worker typecheck
# Render contoh (butuh foto-jasa.jpg & video-jasa.mp4 di .sample-assets/):
cd apps/creative-worker && npx tsx src/sample.ts --assets ./.sample-assets --out ./.sample-out --stills
# Edit template secara visual:
pnpm --filter @iklan/creative-worker studio
```
Build image worker (Docker tidak ada di laptop; dibangun di VPS lewat tar konteks):
```bash
tar --exclude=node_modules --exclude=.sample-assets --exclude=.sample-out -czf - pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json apps/creative-worker \
  | ssh vps3 'cat > /root/cw-context.tgz && docker build -q -f apps/creative-worker/Dockerfile -t creative-worker-test - < /root/cw-context.tgz; rm -f /root/cw-context.tgz'
```

## 9. Sebelum push ke `main`

- `pnpm-lock.yaml` berubah besar (+2.363 baris) karena Remotion; CI menjalankan `pnpm install --frozen-lockfile` untuk seluruh workspace,
  jadi lockfile ini harus ikut di-commit bersama folder `apps/creative-worker/`.
- Dockerfile dashboard hanya memasang `@iklan/api` dan `@iklan/web` (filter), jadi worker **tidak ikut** ter-deploy ke produksi dashboard.
- Worker belum punya aplikasi di Coolify; deploy worker adalah langkah terpisah setelah uji 0.6 lulus.
