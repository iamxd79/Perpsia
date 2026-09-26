# PerpsIA architecture evolution

## 1. Current architecture audit

- **Runtime:** one CommonJS Node.js process started with `node index.js`, using Telegram long polling, scheduled scans, paper-trading monitoring, provider calls, and the health/metrics server in one service.
- **Telegram identity:** `chat_id` is the operational user key. Risk settings, watchlists, preferences, paper positions, analytics, latest scan state, and most command flows use it directly. `bot_users` tracks lifecycle and events, but is not a product account.
- **Storage:** SQLite through `better-sqlite3`. It is durable only when `PERPSIA_DB_PATH` points to Render persistent storage such as `/var/data/perpsia.db`; otherwise a restart or replacement instance can lose state. Several modules open the same SQLite file independently.
- **Intelligence:** scanner V2 orchestrates CMC and public/provider evidence, technical/SMC analysis, lifecycle, scoring, OpenAI/Grok optional reasoning, and Telegram rendering. This is the strongest existing product core and should be preserved.
- **User features:** risk profiles, watchlists, preferences, alerts, paper trading, backtests, signal quality, wallet/onchain intelligence, and private admin analytics are implemented primarily as service-local tables and Telegram handlers.
- **Deployment:** Render runs a single web service with Telegram polling and background timers. This is operationally simple but couples user-facing health, polling, scheduled work, and provider load to one process.

## 2. Main blockers and technical debt

1. No internal account ID independent from Telegram.
2. SQLite is not a suitable long-term shared backend for a web app, multi-instance workers, or Supabase RLS.
3. Telegram polling, API work, scheduled scans, and paper monitoring share one process and failure domain.
4. Product state is split across module-owned schemas without a migration/versioning layer.
5. No verified Telegram-to-web linking flow exists yet.
6. Entitlements, staking, token balances, and usage limits do not exist as first-class domain objects.
7. Provider and AI evidence needs explicit provenance, freshness, cost, and audit records for a public dashboard.
8. Admin analytics are private Telegram commands rather than a protected product surface.

## 3. Recommended target architecture

```text
Telegram bot / Web app
        |
        v
PerpsIA account + identity layer
        |
        +--> Privy auth and wallet identities
        +--> Telegram identity
        +--> Supabase/PostgreSQL user/product data
        +--> entitlement and usage service
        +--> token/staking indexer
        |
        +--> intelligence API --> scanner/provider workers --> evidence store
        +--> alert delivery worker --> Telegram/web notifications
```

Keep the scanner and evidence contracts stable. Move orchestration behind an API/worker boundary progressively rather than rewriting signal logic.

## 4. Account and identity model

- `accounts`: internal immutable `account_id`, lifecycle/status, timestamps.
- `identities`: `(provider, subject)` unique mapping to `account_id`; providers include `telegram`, `privy`, and future OAuth providers.
- `telegram_profiles`: Telegram username/name/chat metadata keyed by identity.
- `wallets`: wallet address, chain, Privy wallet identity, verification state, and labels.
- `account_preferences`, `risk_profiles`, `watchlists`, `alerts`, `analysis_runs`, and `paper_positions` reference `account_id`, not a provider subject.

The current phase adds this identity registry and preserves `chat_id` compatibility. Later migrations backfill all feature tables from `chat_id` to `account_id` with dual reads/writes before removing the legacy key.

## 5. Telegram → Web linking

`/account` creates a short-lived, single-use random token. Only its SHA-256 hash is stored. The bot sends `https://www.perpsia.app/link?token=...`. The web app exchanges the token server-side, authenticates the user with Privy, and consumes the token exactly once. The server links the authenticated Privy subject to the existing Telegram account; raw tokens never appear in logs or database rows.

## 6. Privy strategy

Use Privy as the web authentication and wallet layer, but do not make a wallet address the account primary key. A Privy user ID becomes an identity provider subject. Wallets are linked identities/assets under the PerpsIA account, with explicit chain/address verification and account recovery rules.

## 7. Supabase/PostgreSQL migration

1. Introduce versioned SQL migrations and a Supabase project in staging.
2. Add `accounts` and `identities` first; dual-write new Telegram identities.
3. Backfill feature tables from SQLite using stable account mappings.
4. Add repository interfaces so scanner and Telegram code stop depending directly on SQLite.
5. Run shadow reads and reconciliation reports.
6. Switch reads, retain SQLite export/rollback for one release, then retire local writes.

## 8. `$PERPSIA` integration

Pons remains the token launch layer. PerpsIA should store the official chain/contract configuration, never redeploy or infer contracts. A token metadata registry and balance/indexer adapter should expose verified balances and block timestamps to the entitlement service.

## 9. Staking architecture

Start with read-only on-chain position snapshots and configurable staking rules. Store `staking_snapshots`, `staking_positions`, `staking_rules`, and `staking_events`. Reconcile snapshots periodically and keep the source block number/timestamp. Do not make a single RPC response authoritative without freshness and chain confirmation checks.

## 10. Entitlements

Use a policy engine with configurable tiers and feature limits:

```text
FREE -> core scans, basic history, basic alerts
PRO -> higher scan depth, research, advanced alerts
ADVANCED -> smart-money, backtesting, larger usage limits
ELITE -> API, agents, highest limits
```

Entitlements should be derived from account grants, staking snapshots, promotional grants, and expiry—not hard-coded in handlers. Every decision should be explainable and cacheable with a short TTL.

## 11. Implementation phases

1. **Identity foundation (current):** internal accounts, provider identities, one-time Telegram link sessions, backward-compatible `chat_id` mapping.
2. **Web link endpoint:** web `/link`, Privy callback, account/profile read model, signed session exchange.
3. **PostgreSQL boundary:** migrations, repository interfaces, dual-write and reconciliation.
4. **Dashboard parity:** watchlist, risk, history, alerts, paper trading, and account settings.
5. **Token/staking/entitlements:** verified contract config, indexer, policy engine, usage ledger.
6. **Workers and scale:** separate polling/scan/alert workers, queues, idempotency, observability.
7. **Advanced ecosystem:** API keys, agents, reputation, Proof of Alpha, and marketplace capabilities.

## 12. Security concerns

- Never use Telegram `chat_id`, wallet address, or username as a bearer credential.
- Hash and expire link tokens; consume them transactionally and redact them from logs.
- Validate Telegram webhook/polling provenance and Privy server-side signatures.
- Apply least privilege and RLS in Supabase; keep service-role credentials server-only.
- Treat token balances and staking as untrusted until chain, contract, block, and freshness checks pass.
- Isolate admin analytics and never expose cross-user paper results by default.
- Add idempotency keys to link, staking, alert, and payment-like writes.

## 13. Direction changes recommended

- Keep intelligence—not token speculation—as the primary value proposition.
- Do not launch with a complex staking smart contract; start with a read-only entitlement adapter and configurable rules.
- Do not expose a direct trading execution layer until account security, permissions, audit trails, and risk controls are independently verified.
- Do not split the scanner into microservices before the account/data boundaries are stable; introduce workers only where load or failure isolation proves necessary.

## 14. Phase 3 account-owned state

`accountData.js` is the compatibility boundary for user-owned preferences, risk profiles, and watchlists. Existing Telegram tables remain intact and gain a nullable `account_id`; the first read/write for a Telegram chat creates or resolves its Telegram identity, backfills account-owned tables, and dual-writes the legacy row. Product reads prefer account-owned rows. This keeps existing Telegram users intact while allowing the web dashboard to update the exact state that Telegram reads.

`wallets.js` owns durable wallet identities in `account_wallets`. Wallets are chain-agnostic at the model boundary (`namespace`, `chain_id`, normalized address), with EVM lowercasing and a unique chain/address constraint. A partial unique index guarantees one primary wallet per account. Wallet linking is only exposed after server-side Privy ownership verification; the browser cannot claim an arbitrary address. A wallet already attached to another account returns a conflict and is never merged.

The web dashboard uses `/api/account/overview`, `/api/account/preferences`, `/api/account/risk`, and `/api/account/wallets`. All account mutations resolve the account from the verified Privy subject; no client-provided account ID authorizes a change. `PRIVY_APP_SECRET` is required for wallet ownership lookup, while `PRIVY_VERIFICATION_KEY` remains required for access-token verification.

Legacy removal plan: keep dual-read/dual-write through the next migration window, backfill and audit rows, then stop writing `chat_id` after all command paths use account context. Remove legacy columns only in a separately versioned PostgreSQL migration after production verification.
