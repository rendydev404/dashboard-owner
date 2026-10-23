# Rencana: Konten Iklan Otomatis (Remotion + ElevenLabs MCP)

Status: **rencana, belum dibangun** · Dibuat 22 Okt 2026

## 1. Tujuan

Bot AI di dashboard bisa membuat video iklan pendek (suara + subtitle) dari data akun sendiri, memeriksa kualitasnya,
lalu menyiapkannya sebagai iklan di Meta lewat alur yang sudah ada (upload media → kartu rencana → draft → tayang).

Tahap ini memakai **ElevenLabs gratis lewat MCP** yang login di Claude Code VPS (user `claude-ads`), sama seperti MCP Meta Ads.

## 2. Alur

```
Pemicu (chat / jadwal / creative fatigue)
  → 1. Brief      : Claude menyusun angle dari data akun (iklan pemenang, produk, harga, aturan akun)
  → 2. Naskah     : 15–30 dtk, hook ≤ 3 dtk, isi, CTA. Bahasa Indonesia santai.
  → 3. Suara      : ElevenLabs MCP (text_to_speech) → file audio
  → 4. Timing     : cap waktu per kata (dari ElevenLabs; cadangan: transkripsi lokal)
  → 5. Visual     : aset sendiri dulu (contoh hasil timelapse, rekaman layar, video lama dari perpustakaan Meta)
  → 6. Render     : Remotion di worker terpisah → MP4 9:16 1080×1920 (subtitle, hook, harga, logo, CTA)
  → 7. Gerbang QC : cek teknis + konten + kebijakan Meta (lihat §5)
  → 8. Persetujuan: kartu di chat, owner tap "Setujui"
  → 9. Meta       : upload_media_to_meta → propose_launch → DRAFT (alur yang sudah ada)
  → 10. File sementara dihapus begitu diterima Meta
```

Prinsip: **AI hanya menulis naskah dan memilih**, sedangkan teks, harga, logo, dan tata letak berasal dari template Remotion.
Jadi ejaan dan angka di video selalu benar.

## 3. Fase

### Fase 0: Uji kelayakan (wajib lolos sebelum membangun)
| # | Uji | Lolos kalau | Kalau gagal |
|---|---|---|---|
| 0.1 | Owner login MCP ElevenLabs di VPS: `sudo -u claude-ads -i claude` → `claude mcp add --transport http elevenlabs https://api.elevenlabs.io/v1/mcp` → `/mcp` → Authenticate | `claude mcp list` menampilkan `elevenlabs ✔ Connected` | — |
| 0.2 | Daftar tool (`tools/list`) | Ada tool text-to-speech yang menerima teks + voice | Stop, pakai cadangan B |
| 0.3 | TTS Bahasa Indonesia 20 dtk | Audio bisa **diunduh server** (URL/base64/ID aset) dan terdengar natural | Cadangan B |
| 0.4 | Cap waktu per kata | Tersedia dari TTS **atau** dari tool speech-to-text MCP | Cadangan C (transkripsi lokal) |
| 0.5 | Umur token OAuth ElevenLabs | Berlaku ≥ beberapa hari, atau Claude Code memperbaruinya otomatis | Cadangan A |
| 0.6 | Render Remotion 20 dtk di VPS 3 (2 core) | ≤ 3 menit, RAM ≤ 1,5 GB | Turunkan resolusi/fps atau render di luar VPS |
| 0.7 | Kuota gratis | 1 video 20 dtk ≈ 300–400 kredit dari 10.000/bulan | — |

**Cara memanggil ElevenLabs (dipilih setelah uji 0.5):**
- **Jalur utama:** server dashboard memanggil MCP ElevenLabs langsung (JSON-RPC, tanpa LLM) dengan token yang diekspor
  dari login Claude Code, sama seperti `meta/mcp.ts` + `deploy/export-meta-token.py`. Hasilnya deterministik dan murah kuota Claude.
- **Cadangan A** (token cepat kedaluwarsa): bot Claude di jembatan memanggil MCP ElevenLabs sendiri (Claude Code mengurus token),
  lalu menyerahkan referensi audio ke tool dashboard.
- **Cadangan B** (MCP tidak memberi file audio): REST API ElevenLabs dengan API key (juga tersedia di paket gratis),
  endpoint text-to-speech dengan timestamps.
- **Cadangan C** (tanpa cap waktu): transkripsi lokal (whisper.cpp model kecil) di worker render untuk timing subtitle.

### Fase 1: MVP semi-otomatis (draft saja)
- Tool bot `buat_video_iklan(brief)` → naskah → suara → render → QC → kartu pratinjau (video bisa diputar di chat).
- Owner tap **Setujui** → upload ke Meta → kartu rencana iklan seperti sekarang → **draft**.
- Worker render terpisah (container `creative-worker`), antrean satu-per-satu.
- Catatan run di DB (metadata saja, lihat §6).

### Fase 2: otomatis (setelah ElevenLabs berbayar + 2–4 minggu kalibrasi)
- Jadwal / pemicu creative fatigue membuat variasi dari iklan pemenang **tanpa approval**, dimasukkan ke ad set pemenang.
- Gerbang performa memakai aturan akun yang sudah ada (matikan/pertahankan).

## 4. Aturan


### 4.3 Isi konten
1. Harga, nama produk, dan link **hanya dari data dashboard** (tabel produk/aturan akun), tidak boleh dikarang AI.
2. Tanpa klaim berlebihan, jaminan hasil/penghasilan, before-after menyesatkan, atau menyebut atribut personal penonton.
3. Struktur: hook ≤ 3 dtk → manfaat konkret → bukti (contoh hasil) → CTA. Durasi 15–30 dtk.
4. Subtitle wajib (banyak orang menonton tanpa suara), terbaca di HP, tidak menutupi bagian penting.

### 4.4 Gerbang QC (semua wajib lolos)
| Jenis | Cek |
|---|---|
| Teknis | MP4 H.264, 1080×1920, 15–30 dtk, audio ada & tidak terpotong, ukuran < 100 MB |
| Sinkron | Selisih subtitle vs suara < 0,3 dtk (dari cap waktu) |
| Konten | Naskah memuat produk & CTA yang benar; harga = data dashboard |
| Kebijakan | Claude memeriksa naskah + 4 frame contoh terhadap aturan §4.3; skor ≥ 8/10 |
| Pratinjau Meta | `ads_get_ad_preview_screenshot` dicek sebelum tayang (Fase 2) |

Gagal QC: video dibuang, alasannya dicatat, maks. 1 kali percobaan ulang otomatis.

### 4.5 Persetujuan & akun Meta
1. Fase 0–1: **tidak ada yang tayang tanpa tap owner**; dan selama ElevenLabs gratis, hasil akhirnya draft (§4.1).
2. Maks. **5 iklan baru/minggu per akun** dari sistem ini.
3. Bila Meta menolak ≥ 2 iklan dalam 7 hari: otomasi berhenti sendiri dan owner diberi tahu (melindungi akun iklan).
4. Budget mengikuti aturan akun (`max_daily_budget`, batas CPA/CPL); sistem tidak boleh menaikkan budget sendiri.

### 4.6 File & data
1. Audio, frame, dan video **tidak disimpan di database**. Semua file di disk sementara worker, dihapus setelah diterima Meta,
   atau maks. 24 jam kalau tidak jadi dipakai.
2. Yang disimpan di DB hanya metadata run: brief, naskah, voice, durasi, skor & alasan QC, status, ID media/iklan Meta.
3. Token ElevenLabs hanya diekspor ke file terbatas (seperti token Meta), tidak masuk repo, env build, atau bundle web.

### 4.7 Server
1. Render di container `creative-worker` terpisah: batas 1,5 GB RAM & 1,5 CPU, satu render sekaligus, timeout 10 menit.
2. Dashboard (384 MB) tidak pernah menjalankan Chrome/ffmpeg.
3. Disk VPS 3 sudah 80%: worker membersihkan folder sementaranya setiap selesai dan saat start.

## 5. Yang perlu disiapkan owner
1. Login MCP ElevenLabs di VPS (langkah 0.1). Hanya bisa dilakukan owner karena butuh login browser.
2. Pilih **suara** (voice) Bahasa Indonesia di ElevenLabs.
3. Aset merek: logo (PNG transparan), 2 warna utama, font (opsional), 5–10 klip/foto contoh hasil.
4. Akun target Fase 1 (saran: **Adv Habib Akbar-02**, Produk Digital: sudah ada pemenang & pixel).
5. Konfirmasi jumlah karyawan untuk lisensi Remotion.

## 6. Perubahan teknis (ringkas)
| Bagian | Isi |
|---|---|
| `deploy/export-meta-token.py` | Ikut mengekspor entri `elevenlabs` (jalur utama) |
| `apps/api/src/meta/mcp.ts` | Klien MCP dijadikan umum (Meta & ElevenLabs) |
| `apps/creative-worker/` (baru) | Remotion: template iklan 9:16, antrean render, cap waktu → subtitle |
| `apps/api/src/creative.ts` (baru) | Brief → naskah → suara → minta render → QC → kartu pratinjau |
| Tabel `creative_runs` (baru) | Metadata run (§4.6) |
| Bot | Tool `buat_video_iklan`, `setujui_video`; aturan §4 di prompt |
| Dashboard | Kartu pratinjau video + tombol Setujui/Buang, sisa kuota ElevenLabs |

## 7. Urutan kerja
1. Fase 0 (uji 0.1–0.7), hasilnya ditulis di dokumen ini.
2. Template Remotion + worker + render dari audio contoh.
3. Integrasi ElevenLabs (jalur terpilih) + subtitle.
4. QC + kartu pratinjau + persetujuan.
5. Sambung ke alur upload/draft Meta yang sudah ada, tes ujung ke ujung, bersihkan draft tes.
