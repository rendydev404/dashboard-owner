-- Autopilot Profit Engine: guardrail keselamatan akun, bank aset produk, jejak siklus AI, dan memori eksperimen angle.
ALTER TYPE action_source ADD VALUE IF NOT EXISTS 'autopilot';

ALTER TABLE account_settings
  ADD COLUMN IF NOT EXISTS daily_stop_loss           bigint,
  ADD COLUMN IF NOT EXISTS max_account_daily_budget  bigint,
  ADD COLUMN IF NOT EXISTS cooldown_hours            smallint NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS max_auto_launches_per_day smallint NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS auto_launch_enabled       boolean  NOT NULL DEFAULT true;

-- Bank aset kreatif per produk agar AI dapat menyusun iklan pengganti secara otonom.
CREATE TABLE product_assets (
  id              bigserial PRIMARY KEY,
  product_id      bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  account_id      text REFERENCES ad_accounts(id) ON DELETE SET NULL,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('image','video','post')),
  image_hash      text,
  image_url       text,
  video_id        text,
  thumbnail_hash  text,
  object_story_id text,
  notes           text,
  times_used      integer NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  created_by      bigint REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_assets_prod_active_idx ON product_assets (product_id, times_used ASC, id DESC) WHERE active = true;
CREATE INDEX product_assets_acc_active_idx  ON product_assets (account_id, id DESC) WHERE active = true;

-- Riwayat setiap siklus evaluasi & eksekusi otonom per akun beserta snapshot Laba/Rugi.
CREATE TABLE agent_runs (
  id             bigserial PRIMARY KEY,
  account_id     text NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  trigger        text NOT NULL CHECK (trigger IN ('sync','manual','chat')),
  mode           bot_mode NOT NULL,
  brain          text NOT NULL DEFAULT 'ai' CHECK (brain IN ('ai','deterministic')),
  status         text NOT NULL CHECK (status IN ('running','completed','halted_guardrail','failed')),
  pl_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  diagnosis      text,
  decisions      jsonb NOT NULL DEFAULT '[]'::jsonb,
  guardrail_note text,
  input_tokens   integer,
  output_tokens  integer,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  error          text
);
CREATE INDEX agent_runs_acc_started_idx ON agent_runs (account_id, started_at DESC, id DESC);
CREATE INDEX agent_runs_recent_idx      ON agent_runs (started_at DESC, id DESC);

-- Memori hipotesis kreatif & angle agar AI belajar dari eksperimen sebelumnya dan tidak mengulang angle yang boncos.
CREATE TABLE agent_memories (
  id           bigserial PRIMARY KEY,
  account_id   text NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  product_id   bigint REFERENCES products(id) ON DELETE SET NULL,
  campaign_id  text REFERENCES campaigns(id) ON DELETE SET NULL,
  action_id    bigint REFERENCES bot_actions(id) ON DELETE SET NULL,
  angle        text NOT NULL,
  headline     text,
  hook_summary text,
  outcome      text NOT NULL DEFAULT 'testing' CHECK (outcome IN ('testing','winning','losing','inconclusive')),
  metrics      jsonb NOT NULL DEFAULT '{}'::jsonb,
  lesson       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_memories_acc_updated_idx ON agent_memories (account_id, updated_at DESC, id DESC);
CREATE INDEX agent_memories_testing_idx     ON agent_memories (account_id, campaign_id) WHERE outcome = 'testing';

-- Indeks covering untuk pengecekan cepat cooldown & kuota peluncuran harian per akun.
CREATE INDEX bot_actions_acc_status_created_idx ON bot_actions (account_id, created_at DESC)
  INCLUDE (campaign_id, action, source, status);
