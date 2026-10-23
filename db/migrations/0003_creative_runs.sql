-- Video iklan buatan bot (PLAN konten otomatis bagian 4.6): hanya metadata. File audio/video ada di disk sementara worker & server.
-- Alur status: queued, lalu rendering, lalu review (menunggu owner), lalu approved, lalu uploading, lalu launching, lalu launched.
-- Cabang akhir lain: failed, discarded (dibuang owner), expired (file sementara sudah dihapus sebelum disetujui).
CREATE TYPE creative_status AS ENUM ('queued','rendering','review','approved','uploading','launching','launched','failed','discarded','expired');

CREATE TABLE creative_runs (
  id              bigserial PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES users(id),
  account_id      text NOT NULL REFERENCES ad_accounts(id),
  status          creative_status NOT NULL DEFAULT 'queued',
  progress        smallint NOT NULL DEFAULT 0,
  note            text,
  brief           jsonb NOT NULL,          -- teks video + naskah + adegan (tanpa file)
  plan            jsonb NOT NULL,          -- rencana kampanye yang dijalankan saat owner menyetujui
  worker_job      text,
  media_id        text,                    -- MP4 hasil render di penyimpanan lampiran sementara
  voice           jsonb,
  qc              jsonb,
  result          jsonb,
  action_id       bigint REFERENCES bot_actions(id) ON DELETE SET NULL,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz
);
-- Batas 5 iklan baru/minggu per akun (PLAN bagian 4.5) dihitung dari sini.
CREATE INDEX creative_runs_account_created_idx ON creative_runs (account_id, created_at DESC);
