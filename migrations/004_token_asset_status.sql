ALTER TABLE token_assets ALTER COLUMN contract_address DROP NOT NULL;
ALTER TABLE token_assets ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE token_assets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'planned';
ALTER TABLE token_assets ADD COLUMN IF NOT EXISTS network TEXT;
CREATE INDEX IF NOT EXISTS idx_token_assets_symbol_status ON token_assets(symbol, status);
