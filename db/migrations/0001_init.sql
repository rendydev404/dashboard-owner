-- Skema awal Dashboard Iklan (PLANNING §4). Uang = rupiah bulat (bigint).
CREATE TYPE business_line AS ENUM ('digital','jasa');
CREATE TYPE user_role     AS ENUM ('owner','admin');
CREATE TYPE bot_mode      AS ENUM ('off','suggest','auto');
CREATE TYPE action_status AS ENUM ('pending','executed','failed','cancelled','expired','reverted');
CREATE TYPE action_source AS ENUM ('chat','table','rule_engine');

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          user_role NOT NULL DEFAULT 'admin',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          text PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE ad_accounts (
  id                 text PRIMARY KEY,
  display_name       text NOT NULL,
  line               business_line NOT NULL,
  currency           text NOT NULL DEFAULT 'IDR',
  timezone           text NOT NULL DEFAULT 'Asia/Jakarta',
  result_action_type text NOT NULL,
  bot_mode           bot_mode NOT NULL DEFAULT 'suggest',
  active             boolean NOT NULL DEFAULT true,
  last_synced_at     timestamptz,
  sort_order         smallint NOT NULL DEFAULT 0
);

CREATE TABLE account_settings (
  account_id        text PRIMARY KEY REFERENCES ad_accounts(id) ON DELETE CASCADE,
  target_roas       numeric(6,2) NOT NULL,
  max_cpa           bigint,
  max_cpl           bigint,
  ad_tax_pct        numeric(5,2) NOT NULL DEFAULT 11,
  scale_step_pct    smallint NOT NULL DEFAULT 20,
  kill_after_spend  bigint NOT NULL,
  max_daily_budget  bigint,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        bigint REFERENCES users(id)
);

-- Fee platform per lini (lynk.id tidak terikat akun iklan).
CREATE TABLE line_settings (
  line    business_line PRIMARY KEY,
  fee_pct numeric(5,2) NOT NULL DEFAULT 0
);
INSERT INTO line_settings (line, fee_pct) VALUES ('digital', 0), ('jasa', 0);

CREATE TABLE campaigns (
  id               text PRIMARY KEY,
  account_id       text NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  name             text NOT NULL,
  status           text NOT NULL,
  effective_status text NOT NULL,
  objective        text,
  daily_budget     bigint,
  lifetime_budget  bigint,
  is_cbo           boolean NOT NULL DEFAULT false,
  created_time     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_account_idx ON campaigns (account_id);

CREATE TABLE campaign_daily (
  campaign_id    text   NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  date           date   NOT NULL,
  account_id     text   NOT NULL,
  spend          bigint NOT NULL DEFAULT 0,
  impressions    bigint NOT NULL DEFAULT 0,
  clicks         bigint NOT NULL DEFAULT 0,
  leads          integer NOT NULL DEFAULT 0,
  purchases      integer NOT NULL DEFAULT 0,
  purchase_value bigint NOT NULL DEFAULT 0,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, date)
);
CREATE INDEX campaign_daily_acc_date_idx ON campaign_daily (account_id, date)
  INCLUDE (campaign_id, spend, impressions, clicks, leads, purchases, purchase_value);

CREATE TABLE account_hourly (
  account_id  text     NOT NULL,
  date        date     NOT NULL,
  hour        smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  spend       bigint   NOT NULL DEFAULT 0,
  impressions bigint   NOT NULL DEFAULT 0,
  clicks      bigint   NOT NULL DEFAULT 0,
  leads       integer  NOT NULL DEFAULT 0,
  purchases   integer  NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, date, hour)
);

CREATE TABLE products (
  id          bigserial PRIMARY KEY,
  line        business_line NOT NULL,
  name        text NOT NULL,
  price       bigint,
  cogs        bigint NOT NULL DEFAULT 0,
  url         text,
  lynk_uuid   text UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (line, name)
);

CREATE TABLE sales (
  id           bigserial PRIMARY KEY,
  line         business_line NOT NULL,
  account_id   text REFERENCES ad_accounts(id) ON DELETE SET NULL,
  product_id   bigint REFERENCES products(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  date         date NOT NULL,
  occurred_at  timestamptz NOT NULL,
  qty          integer NOT NULL DEFAULT 1,
  revenue      bigint NOT NULL,
  cogs         bigint,
  client       text,
  source       text,
  channel      text NOT NULL,
  lynk_ref_id  text,
  lynk_item_ix smallint,
  created_by   bigint REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  UNIQUE (lynk_ref_id, lynk_item_ix)
);
CREATE INDEX sales_line_date_idx ON sales (line, date) INCLUDE (account_id, product_id, qty, revenue, cogs) WHERE deleted_at IS NULL;
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
CREATE INDEX manual_costs_recent_idx ON manual_costs (created_at DESC, id DESC) WHERE deleted_at IS NULL;

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
CREATE INDEX lynk_events_received_idx ON lynk_events (received_at);

CREATE TABLE bot_actions (
  id            bigserial PRIMARY KEY,
  account_id    text REFERENCES ad_accounts(id) ON DELETE SET NULL,
  campaign_id   text REFERENCES campaigns(id) ON DELETE SET NULL,
  action        text NOT NULL,
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  source        action_source NOT NULL,
  status        action_status NOT NULL,
  reason        text,
  requested_by  bigint REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  executed_at   timestamptz,
  meta_response jsonb,
  error         text
);
CREATE INDEX bot_actions_created_idx ON bot_actions (created_at DESC, id DESC);
CREATE INDEX bot_actions_campaign_idx ON bot_actions (campaign_id, created_at DESC);

CREATE TABLE chat_messages (
  id                bigserial PRIMARY KEY,
  conversation_id   uuid NOT NULL,
  user_id           bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role              text NOT NULL,
  content           jsonb NOT NULL,
  input_tokens      integer,
  output_tokens     integer,
  cache_read_tokens integer,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_conv_idx ON chat_messages (conversation_id, id);
CREATE INDEX chat_messages_user_created_idx ON chat_messages (user_id, created_at);

CREATE TABLE sync_runs (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  account_id  text,
  since       date,
  until       date,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  rows        integer,
  status      text NOT NULL DEFAULT 'running',
  error       text
);
CREATE INDEX sync_runs_started_idx ON sync_runs (started_at DESC);

CREATE TABLE app_state (key text PRIMARY KEY, value jsonb NOT NULL);
INSERT INTO app_state (key, value) VALUES ('data_version', '1'::jsonb);
