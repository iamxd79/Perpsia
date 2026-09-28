CREATE TABLE IF NOT EXISTS telegram_link_sessions (
  session_id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  account_id UUID NOT NULL REFERENCES perpsia_accounts(account_id),
  telegram_subject TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_link_sessions_expiry
  ON telegram_link_sessions(expires_at, consumed_at);
