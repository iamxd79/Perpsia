CREATE TABLE IF NOT EXISTS token_assets (
  asset_id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  chain_namespace TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  is_official BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(chain_namespace, chain_id, contract_address)
);

CREATE TABLE IF NOT EXISTS wallet_token_balances (
  wallet_id BIGINT NOT NULL REFERENCES account_wallets(wallet_id),
  asset_id BIGINT NOT NULL REFERENCES token_assets(asset_id),
  balance NUMERIC NOT NULL DEFAULT 0,
  block_number BIGINT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(wallet_id, asset_id)
);

CREATE TABLE IF NOT EXISTS staking_positions (
  staking_position_id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES perpsia_accounts(account_id),
  wallet_id BIGINT REFERENCES account_wallets(wallet_id),
  asset_id BIGINT REFERENCES token_assets(asset_id),
  amount NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entitlements (
  entitlement_id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES perpsia_accounts(account_id),
  tier TEXT NOT NULL,
  source TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
