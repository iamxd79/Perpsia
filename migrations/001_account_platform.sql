CREATE TABLE IF NOT EXISTS perpsia_accounts (
  account_id UUID PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS perpsia_identities (
  identity_id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES perpsia_accounts(account_id),
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_perpsia_identities_account ON perpsia_identities(account_id);

CREATE TABLE IF NOT EXISTS account_wallets (
  wallet_id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES perpsia_accounts(account_id),
  chain_namespace TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  address_normalized TEXT NOT NULL,
  address_display TEXT NOT NULL,
  wallet_type TEXT NOT NULL DEFAULT 'external',
  provider TEXT,
  custody TEXT NOT NULL DEFAULT 'external',
  ownership_status TEXT NOT NULL DEFAULT 'verified',
  is_primary BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chain_namespace, chain_id, address_normalized)
);
CREATE INDEX IF NOT EXISTS idx_account_wallets_account ON account_wallets(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_wallets_primary ON account_wallets(account_id) WHERE is_primary;

CREATE TABLE IF NOT EXISTS account_preferences (
  account_id UUID PRIMARY KEY REFERENCES perpsia_accounts(account_id),
  preferred_exchange TEXT NOT NULL DEFAULT 'Binance',
  alert_frequency TEXT NOT NULL DEFAULT '4h',
  signal_sensitivity TEXT NOT NULL DEFAULT 'balanced',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS account_risk_profiles (
  account_id UUID PRIMARY KEY REFERENCES perpsia_accounts(account_id),
  capital NUMERIC,
  risk_percent NUMERIC,
  max_leverage NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS account_watchlist (
  account_id UUID NOT NULL REFERENCES perpsia_accounts(account_id),
  symbol TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id, symbol)
);

CREATE TABLE IF NOT EXISTS account_analysis_history (
  analysis_id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES perpsia_accounts(account_id),
  symbol TEXT NOT NULL,
  venue TEXT,
  analysis_type TEXT NOT NULL,
  request_source TEXT NOT NULL,
  result_reference TEXT,
  signal_reference TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_analysis_history_account_time ON account_analysis_history(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS account_alerts (
  alert_id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES perpsia_accounts(account_id),
  symbol TEXT,
  alert_type TEXT NOT NULL,
  condition JSONB NOT NULL DEFAULT '{}'::jsonb,
  destinations JSONB NOT NULL DEFAULT '["telegram"]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_alerts_account_status ON account_alerts(account_id, status);

CREATE TABLE IF NOT EXISTS account_paper_positions (
  position_id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES perpsia_accounts(account_id),
  symbol TEXT NOT NULL,
  venue TEXT NOT NULL DEFAULT 'Binance',
  direction TEXT NOT NULL CHECK(direction IN ('LONG', 'SHORT')),
  margin NUMERIC NOT NULL,
  leverage NUMERIC NOT NULL,
  notional NUMERIC NOT NULL,
  quantity NUMERIC NOT NULL,
  entry_price NUMERIC NOT NULL,
  mark_price NUMERIC NOT NULL,
  stop_loss NUMERIC,
  take_profit NUMERIC,
  status TEXT NOT NULL DEFAULT 'OPEN',
  realized_pnl NUMERIC,
  exit_price NUMERIC,
  exit_reason TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_account_paper_positions_account_status ON account_paper_positions(account_id, status);

CREATE TABLE IF NOT EXISTS account_usage_events (
  usage_id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES perpsia_accounts(account_id),
  event_type TEXT NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_usage_events_account_time ON account_usage_events(account_id, created_at DESC);
