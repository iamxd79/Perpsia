# PerpsIA token and access foundation

The canonical registry currently marks `$PERPSIA` as a `mock` asset on Robinhood Chain Testnet (`eip155:46630`). There is no verified mainnet token contract or production staking contract in this repository.

`services/chainRegistry.js` centralizes Robinhood Chain mainnet (`4663`) and testnet (`46630`) configuration. `services/tokenBalance.js` performs read-only `eth_call` balance reads for verified account wallets, with a bounded cache and an explicit degraded state when RPC is unavailable. No transfer, approval, signing, or wallet write is implemented.

`services/staking.js` is a mock/test ledger with idempotent event storage and indexer checkpoints. Writes are rejected when `PERPSIA_STAKING_MODE` is not `mock`. Entitlements are centralized in `services/entitlements.js`; access checks use `canUseFeature(accountId, feature)` rather than handler-specific balance thresholds.

Before production token access, complete contract audit and verification, staking contract audit, indexer reconciliation, PostgreSQL staging validation, operational alerting, and legal/custody review. Never present the mock balance or staking ledger as real holdings.

Health diagnostics now expose only non-sensitive state for the configured chain, asset, staking mode/address presence, and indexer configuration. They do not expose RPC URLs, credentials, private keys, or wallet secrets.
