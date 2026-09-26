"use strict";

const { openDatabase } = require("./database");

const db = openDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS account_wallets (
    wallet_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    chain_namespace TEXT NOT NULL,
    chain_id TEXT NOT NULL,
    address_normalized TEXT NOT NULL,
    address_display TEXT NOT NULL,
    wallet_type TEXT NOT NULL DEFAULT 'external',
    provider TEXT,
    custody TEXT NOT NULL DEFAULT 'external',
    ownership_status TEXT NOT NULL DEFAULT 'verified',
    is_primary INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chain_namespace, chain_id, address_normalized),
    FOREIGN KEY(account_id) REFERENCES perpsia_accounts(account_id)
  );
  CREATE INDEX IF NOT EXISTS idx_account_wallets_account ON account_wallets(account_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_account_wallets_primary
    ON account_wallets(account_id) WHERE is_primary = 1;
`);

function normalizeChain(chain = {}) {
  const namespace = String(chain.namespace || chain.chainNamespace || "eip155").trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(namespace)) throw new Error("Unsupported wallet chain namespace.");
  const chainId = String(chain.id ?? chain.chainId ?? (namespace === "eip155" ? "1" : "unknown")).trim();
  if (!chainId || chainId.length > 80) throw new Error("A valid wallet chain is required.");
  return { namespace, chainId };
}

function normalizeAddress(address, namespace) {
  const value = String(address || "").trim();
  if (!value || value.length > 256) throw new Error("A valid wallet address is required.");
  if (namespace === "eip155") {
    if (!/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error("Invalid EVM wallet address.");
    return value.toLowerCase();
  }
  if (/\s/.test(value)) throw new Error("Invalid wallet address.");
  return value;
}

function parseMetadata(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function readWallet(row) {
  if (!row) return null;
  return {
    walletId: row.wallet_id,
    accountId: row.account_id,
    chain: { namespace: row.chain_namespace, id: row.chain_id },
    address: row.address_display,
    normalizedAddress: row.address_normalized,
    walletType: row.wallet_type,
    provider: row.provider,
    custody: row.custody,
    ownershipStatus: row.ownership_status,
    isPrimary: Boolean(row.is_primary),
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getUserWallets(accountId) {
  return db.prepare(`SELECT * FROM account_wallets WHERE account_id = ? ORDER BY is_primary DESC, created_at ASC, wallet_id ASC`)
    .all(String(accountId)).map(readWallet);
}

function getPrimaryWallet(accountId) {
  return readWallet(db.prepare("SELECT * FROM account_wallets WHERE account_id = ? AND is_primary = 1 LIMIT 1").get(String(accountId))) || null;
}

function resolveAccountByWallet(wallet = {}) {
  const chain = normalizeChain(wallet.chain || wallet);
  const normalized = normalizeAddress(wallet.address, chain.namespace);
  const row = db.prepare(`SELECT * FROM account_wallets WHERE chain_namespace = ? AND chain_id = ? AND address_normalized = ?`)
    .get(chain.namespace, chain.chainId, normalized);
  return row ? readWallet(row) : null;
}

function linkWallet(accountId, wallet = {}) {
  const id = String(accountId || "").trim();
  if (!id) throw new Error("A valid account is required.");
  const chain = normalizeChain(wallet.chain || wallet);
  const normalized = normalizeAddress(wallet.address, chain.namespace);
  const existing = resolveAccountByWallet({ chain, address: wallet.address });
  if (existing && existing.accountId !== id) {
    const error = new Error("This wallet is already linked to another PerpsIA account.");
    error.code = "WALLET_ACCOUNT_CONFLICT";
    throw error;
  }
  if (existing) return existing;
  const current = getPrimaryWallet(id);
  const isPrimary = wallet.isPrimary === true || !current;
  const insert = db.transaction(() => {
    if (isPrimary) db.prepare("UPDATE account_wallets SET is_primary = 0, updated_at = CURRENT_TIMESTAMP WHERE account_id = ?").run(id);
    db.prepare(`INSERT INTO account_wallets (
      account_id, chain_namespace, chain_id, address_normalized, address_display,
      wallet_type, provider, custody, ownership_status, is_primary, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, chain.namespace, chain.chainId, normalized, String(wallet.address).trim(),
        String(wallet.walletType || "external"), wallet.provider ? String(wallet.provider) : null,
        String(wallet.custody || (wallet.embedded ? "embedded" : "external")),
        String(wallet.ownershipStatus || "verified"), isPrimary ? 1 : 0,
        JSON.stringify(wallet.metadata && typeof wallet.metadata === "object" ? wallet.metadata : {}));
  });
  insert();
  return resolveAccountByWallet({ chain, address: wallet.address });
}

function setPrimaryWallet(accountId, walletId) {
  const id = String(accountId);
  const wallet = db.prepare("SELECT wallet_id FROM account_wallets WHERE wallet_id = ? AND account_id = ?").get(Number(walletId), id);
  if (!wallet) throw new Error("Wallet not found for this account.");
  db.transaction(() => {
    db.prepare("UPDATE account_wallets SET is_primary = 0, updated_at = CURRENT_TIMESTAMP WHERE account_id = ?").run(id);
    db.prepare("UPDATE account_wallets SET is_primary = 1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = ? AND account_id = ?").run(Number(walletId), id);
  })();
  return getPrimaryWallet(id);
}

function unlinkWallet(accountId, walletId) {
  const id = String(accountId);
  const wallet = db.prepare("SELECT * FROM account_wallets WHERE wallet_id = ? AND account_id = ?").get(Number(walletId), id);
  if (!wallet) throw new Error("Wallet not found for this account.");
  const count = db.prepare("SELECT COUNT(*) AS count FROM perpsia_identities WHERE account_id = ?").get(id).count;
  if (Number(count) === 0) throw new Error("The account has no authentication identity.");
  db.prepare("DELETE FROM account_wallets WHERE wallet_id = ? AND account_id = ?").run(Number(walletId), id);
  if (wallet.is_primary) {
    const next = db.prepare("SELECT wallet_id FROM account_wallets WHERE account_id = ? ORDER BY created_at ASC, wallet_id ASC LIMIT 1").get(id);
    if (next) db.prepare("UPDATE account_wallets SET is_primary = 1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = ?").run(next.wallet_id);
  }
  return { removed: true };
}

module.exports = { getUserWallets, getPrimaryWallet, linkWallet, unlinkWallet, setPrimaryWallet, resolveAccountByWallet, normalizeAddress, normalizeChain };
