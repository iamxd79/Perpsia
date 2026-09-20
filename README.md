# Perpsia Terminal




Perpsia is a perpetual-futures market intelligence assistant designed to help
traders research markets, review opportunities, monitor changes, and receive
structured Telegram reports.




The project currently includes:




- a live Telegram bot deployed on Render;
- a Node.js intelligence workflow for scans, analysis, memory, lifecycle,
  counter-thesis, risk settings, and alerts;
- a verified CoinMarketCap Skill Hub MCP worker prototype;
- a separate landing page and product branding.




Perpsia is a research tool. It does not guarantee profits and does not replace
independent research or risk management.




---




## Product vision




Perpsia is being built as an autonomous market intelligence layer for
perpetual-futures traders.




The long-term workflow is:




```text
User request or scheduled scan
        ↓
Market discovery
        ↓
Single-asset analysis
        ↓
Evidence validation
        ↓
Perpsia classification
        ↓
Counter-thesis and risk review
        ↓
Memory and lifecycle comparison
        ↓
Telegram report or alert
```




The goal is not to blindly copy provider output. External data is treated as
research evidence, while Perpsia remains responsible for its own interpretation,
risk rules, and final presentation.




---




## Current live bot




The Telegram bot is deployed on Render and supports a conversational research
workflow.




### Commands




```text
/start
/help
/scan
/analyze BTC
/analyze $BTC
/analyze BTC Binance
/alpha
/alpha TOKEN
/risk 500 1 5
/watchlist
/watchlist add SOL
/watchlist remove SOL
/history BTC
/compare SOL ETH
/backtest BTC
/performance
/status
/settings
/about
/chatid
```




### Natural-language examples




```text
Analyze BTC
Analyze $BTC
BTC
$ETH
Scan the market
Find futures opportunities
I have $500, risk 1%, max leverage 5x
Check Perpsia status
Show me early alpha
Compare SOL and ETH
Track HYPE
How has BTC changed since the last scan?
```




### Current bot capabilities




- Telegram bot interface
- Natural-language intent routing
- Market scan workflow
- Single-asset analysis workflow
- Long / short / watchlist / neutral classification
- SQLite memory
- Opportunity lifecycle tracking
- Signal-decay detection
- Counter-thesis generation
- Personalized risk settings
- Structured report composition
- OpenAI reasoning support
- Autonomous four-hour scheduler
- Smart alerts
- Shared scan lock
- Basic rate limiting and anti-spam protection
- Binance, Bybit, OKX, dYdX, and Hyperliquid venue-aware analysis
- Public RPC on-chain transfer monitoring for supported assets
- Paper-signal performance leaderboard at /performance
- JSON performance APIs at /api/performance and /api/performance/trades
- Prometheus metrics at /metrics
- Retry and circuit-breaker protection around provider calls




---




## Multi-source provider engine

PerpsIA keeps CoinMarketCap Skill Hub as a working source and now exposes a common provider layer under services/providers/. Provider responses are normalized before they reach the PerpsIA scoring engine; missing fields remain null, and provider errors become health records instead of crashing a scan.

Registered providers:

- CoinMarketCap Skill Hub/API (existing integration);
- Binance, Bybit, OKX, and Hyperliquid public derivatives feeds;
- DexScreener and GeckoTerminal public DEX discovery feeds;
- GoPlus Security and Honeypot.is security checks;
- Alternative.me Crypto Fear & Greed;
- FRED macro observations;
- GitHub public repository activity;
- Alchemy Address Activity and EVM JSON-RPC on-chain evidence (optional);
- GMGN read-only token, Smart Money, market, security, pool, and wallet intelligence (optional);
- public WebSocket stream adapters for the four derivative venues.

The default bounded scan uses CMC plus Binance, Bybit, OKX, Hyperliquid, DexScreener, and Alternative.me. GeckoTerminal and the optional contract, macro, and project providers are enabled only when their required context or configuration is present. This prevents PerpsIA from inventing a token contract, project repository, or unavailable macro value.

### Provider configuration

    PERPSIA_PROVIDER_LIST=binance,bybit,okx,hyperliquid,dexscreener,alternative
    PERPSIA_ENABLE_GECKO=true
    PERPSIA_ENABLE_OPTIONAL_PROVIDERS=true
    FRED_API_KEY=
    FRED_SERIES_ID=DFF
    PERPSIA_TOKEN_CONTRACT=
    PERPSIA_TOKEN_CHAIN_ID=1
    GITHUB_REPOSITORY=owner/repository
    GITHUB_TOKEN=
    PERPSIA_ENABLE_TECHNICAL_CONTEXT=true
    PERPSIA_ENABLE_GROK_RESEARCH=false
    XAI_API_KEY=
    XAI_MODEL=grok-4.6
    XAI_RESEARCH_TIMEOUT_MS=12000
    PERPSIA_ENABLE_WEBSOCKETS=true
    PERPSIA_WS_STALE_MS=30000
    PERPSIA_WS_IDLE_TTL_MS=900000
    ALCHEMY_ENABLED=false
    ALCHEMY_API_KEY=
    ALCHEMY_TIMEOUT_MS=8000
    ALCHEMY_NETWORKS=ethereum,base,arbitrum,bnb,polygon
    ALCHEMY_WEBHOOK_SIGNING_KEY=
    ALCHEMY_NOTIFY_AUTH_TOKEN=
    ALCHEMY_WEBHOOK_URL=
    ALCHEMY_SYNC_INTERVAL_MS=900000
    GMGN_ENABLED=false
    GMGN_API_KEY=
    GMGN_TIMEOUT_MS=8000

CEX, DEX, sentiment, security, macro, and project credentials are read server-side only. Public CEX/DEX/Alternative.me/GoPlus/Honeypot calls do not require an API key. FRED requires FRED_API_KEY; GitHub works unauthenticated at its lower public limit and can use the server-only GITHUB_TOKEN for a higher limit.

/health reports the provider catalog, REST and WebSocket status, current subscriptions, reconnects, last successful messages, freshness failures, retry-after information, and circuit-breaker state. services/providers/streamManager.js keeps deduplicated subscriptions alive for symbols actually being analyzed, while services/providers/liveSnapshotStore.js exposes normalized live snapshots. The Telegram scan remains request-bounded and uses the same normalized evidence contract.

### Alchemy on-chain evidence

Alchemy is an optional primary raw on-chain provider inside the existing `ONCHAIN` evidence group. It does not create a second scoring path. When enabled, the provider uses `alchemy_getAssetTransfers` for ERC-20 transfer activity, `alchemy_getTokenMetadata` for token metadata, and `alchemy_getTokenBalances` for configured watched addresses. Existing public JSON-RPC collection remains the fallback when Alchemy is disabled, unconfigured, rate-limited, or stale. Known exchange attribution comes only from `ONCHAIN_EXCHANGE_ADDRESSES`; unknown addresses remain wallets.

Supported configured EVM networks are Ethereum, Base, Arbitrum, Optimism, Polygon, and BNB Smart Chain. The default list is controlled by `ALCHEMY_NETWORKS`. Asset contracts remain in the existing `ONCHAIN_ASSET_REGISTRY`; entries may include `watchedAddresses` or `watched_addresses` arrays. Exchange addresses remain in `ONCHAIN_EXCHANGE_ADDRESSES`, so Alchemy and the public-RPC fallback use the same address registry.

Configure the Alchemy Address Activity webhook to POST to `https://<your-render-service>/webhooks/alchemy`. The endpoint verifies the raw body with `X-Alchemy-Signature` and `ALCHEMY_WEBHOOK_SIGNING_KEY`, then inserts events into the existing persistent SQLite database with an idempotent event key. The signing key is copied from the webhook's detail page in the Alchemy Dashboard after the webhook is created. Webhook events are attributed as `alchemy_webhook` and are deduplicated against transfer polling before entering normalized ONCHAIN evidence.

The `/health` response includes `onchain.storage`, `onchain.alchemy`, and the provider catalog. Prometheus `/metrics` includes Alchemy request latency, request status, event ingestion, and webhook duplicate counters. No Alchemy secret is sent to the frontend or written to logs.

### Wallet and exchange intelligence

PerpsIA stores one canonical watched-wallet registry in SQLite. It is the source of truth for manually approved CT/KOL wallets, GMGN-classified Smart Money wallets, and verified exchange clusters. Raw transfers remain in the existing `onchain_events` table; registry-linked relationships are stored separately so Alchemy and GMGN observations are not counted as independent directional confirmations.

Wallet evidence is deterministic and remains inside `ONCHAIN`. It reports Smart Money/KOL net flow, verified exchange inflow/outflow, wallet convergence, repeated buys/sells, unique tracked participants, accumulation/distribution, flow acceleration across 15m/1h/4h/24h windows, and new-token exposure. Wallet evidence never creates LONG or SHORT direction by itself.

Exchange activity produces `LISTING_WATCH` records only. A possible listing is never shown as confirmed unless an explicit official exchange source is supplied. The health response includes `onchain.walletRegistry` and `onchain.alchemySync`; Prometheus exposes registry, wallet-event, convergence, exchange-flow, listing-watch, GMGN-import, and Alchemy watchlist-sync metrics.

Automatic Alchemy Address Activity synchronization is optional. When `ALCHEMY_NOTIFY_AUTH_TOKEN` and `ALCHEMY_WEBHOOK_URL` (or `RENDER_EXTERNAL_URL`) are configured, PerpsIA manages one Address Activity webhook per configured EVM network, only when the webhook URL matches its own callback. It adds enabled canonical addresses and removes disabled addresses from those PerpsIA-managed webhooks; unrelated Alchemy webhooks are not modified. Without the Notify token, the raw webhook endpoint continues to work but the remaining dashboard synchronization step is reported in `/health`.

The internal `services/walletAdmin.js` utility exposes guarded application-level operations for adding, disabling, enabling, relabeling, approving, importing, listing, and inspecting wallets, triggering Alchemy sync, and reading listing-watch events. It is intentionally not exposed as a public HTTP admin API without authentication.

### Bulk wallet watchlist administration

The local/server-side CLI is `npm run wallet-admin -- <command>`. It supports `import-gmgn`, `import-gmgn-smart-money`, `import-exchange`/`import-exchange-dataset`, `import-kol`, `import-funds`, `verify-pending`, `approve`, `list`, `disable`, `enable`, `refresh-wallets`, `alchemy-sync`, `alchemy-status`, and `history`. JSON imports accept either an array or an object containing `wallets`/`records`. The empty templates in `templates/verified-exchanges.json`, `templates/verified-kols.json`, and `templates/verified-funds.json` contain no invented addresses.

Bulk ingestion normalizes `chain + address`, rejects malformed addresses and invalid provenance, deduplicates within a batch, records source provenance, and preserves stronger existing verification and manually approved identity metadata. Pending exchange/curated records are stored disabled until reviewed; rejected records are never enabled. The CLI's `verify-pending` command is review-only, while `approve --id <id>` performs an explicit manual approval.

GMGN Smart Money quality is deterministic. The weighted score uses observed realized P&L, win rate, profitable-trade ratio, trade count, recent activity, entry timing, early-entry frequency, rug exposure, token diversity, drawdown, consistency, and data freshness. Unobserved fields are excluded rather than fabricated. Default tiers are LOW (<40), WATCH (40-59), QUALITY (60-74), HIGH_QUALITY (75-89), and ELITE (90+); thresholds can be configured with the `PERPSIA_WALLET_QUALITY_*` variables.

Alchemy synchronization selects only enabled, eligible EVM wallets, sorts by monitoring priority, and applies `PERPSIA_WALLET_MIN_SYNC_PRIORITY` and `PERPSIA_MAX_ALCHEMY_WATCHED_ADDRESSES`. Verified exchange deposit/aggregation/hot wallets receive priority 100; ELITE and HIGH_QUALITY Smart Money receive 90 and 80; verified KOL and fund categories receive their configured lower tiers. Solana wallets remain in the canonical registry but are not sent to the current Alchemy EVM Address Activity synchronizer.

### GMGN read-only intelligence

GMGN is an optional read-only provider. When enabled for a token with an explicit `gmgnChain` and contract address, PerpsIA queries the official OpenAPI read-auth routes for token info, security, pool data, Smart Money-tagged holders/traders, and public Smart Money activity. Market trending and Trenches helpers are available through the same provider module for discovery workflows. The normalized result is added to the existing `ONCHAIN` evidence group with `providerClass: GMGN_READ_ONLY`; it is not a separate scoring engine and it cannot create a LONG or SHORT decision by itself.

Only `GMGN_API_KEY` is used. `GMGN_PRIVATE_KEY` is intentionally excluded. PerpsIA never calls GMGN swap, order, strategy, cooking, follow-wallet, or holdings routes. Wallet activity and wallet statistics are available only for explicitly supplied public wallet addresses through read-auth routes. GMGN and Alchemy are treated as the same ONCHAIN evidence class, and transaction/wallet/token identifiers are retained for deduplication and attribution.

Set these server-side values on Render:

    GMGN_ENABLED=true
    GMGN_API_KEY=
    GMGN_TIMEOUT_MS=8000

The official GMGN client uses `https://openapi.gmgn.ai`, `X-APIKEY`, and short-lived `timestamp`/`client_id` query parameters for normal read-auth requests. See the [official GMGN client](https://github.com/GMGNAI/gmgn-skills/blob/main/src/client/OpenApiClient.ts) for the published request contract. Never expose `GMGN_API_KEY` in frontend code.

### Live freshness and fallback

For Binance, Bybit, OKX, and Hyperliquid, a fresh WebSocket snapshot is preferred when it exists. REST remains the bootstrap, reconciliation, and fallback source. If both sources are stale, the evidence is marked unusable and cannot increase confidence. Freshness thresholds are centralized by evidence class: order book 5 seconds, price 15 seconds, derivatives 2 minutes, DEX 3 minutes, technical 2 minutes, macro 1 hour, project activity 6 hours, security 24 hours, and research 30 minutes.

When WebSocket and REST disagree materially, the record keeps both timestamps and values in reconciliation metadata, confidence is reduced through the existing evidence-quality pipeline, and the event is counted in Prometheus metrics. No second scoring engine is introduced.

### Deterministic TA and SMC layer

PerpsIA now calculates a deterministic technical context from public Binance futures OHLCV before it asks any research model for interpretation. The SMC-style layer reports observable price-structure patterns such as market structure, BOS/CHoCH, liquidity sweeps, equal levels, fair value gaps, order blocks, displacement, and premium/discount zones. These labels describe price action; they are not treated as proof of institutional intent.

### Grok research layer

Grok is an optional secondary research source. When enabled with `PERPSIA_ENABLE_GROK_RESEARCH=true` and `XAI_API_KEY`, PerpsIA can use xAI Web Search and X Search to collect fresh, cited catalysts, narratives, and sentiment. Grok cannot create a direction, entry, stop, target, or actionable signal by itself. Structured market data and deterministic PerpsIA rules remain authoritative, and uncited or unavailable research is ignored for confidence.
Grok and OpenAI validation run only after usable structured market evidence exists. Wide scans can expose early LONG/SHORT candidates, while the models provide bounded secondary confirmation; they cannot bypass the actionable score, data-quality, security, or risk gates. `PERPSIA_AI_VALIDATION_CANDIDATES` limits the number of data-complete candidates sent to either model per scan.

---

## CoinMarketCap Skill Hub integration




Perpsia also includes a separate CMC Skill Hub worker prototype that has been
verified against the live MCP service.




The verified flow is:




```text
Perpsia worker
  -> MCP bridge
  -> CMC Skill Hub
  -> find_skill
  -> execute_skill
  -> altcoin_scanner_perp / perp_contract_analysis
  -> evidence validation
  -> structured research output
```




### Verified health check




```bash
npm run worker -- cmc health --live
```




Verified response:




```json
{
  "live": true,
  "persistence": "NO_SNAPSHOT_WRITE",
  "status": "HEALTHY",
  "tools": [
    "find_skill",
    "execute_skill"
  ],
  "skills": {
    "discovery": "altcoin_scanner_perp",
    "analysis": "perp_contract_analysis"
  }
}
```




### Verified discovery run




```bash
npm run worker -- cmc discover --dry-run --live
```




The live response confirmed:




- successful skill execution;
- `rawSkillId: altcoin_scanner_perp`;
- a CoinMarketCap-branded research report;
- ranked perpetual-altcoin candidates;
- provider-envelope validation and admission metadata.




### Single-asset analysis




SOL example:




```bash
npm run worker -- cmc analyze --cmcid 5426 --dry-run --live
```




This worker uses `perp_contract_analysis` for the requested asset.




### Important integration status




The live MCP worker has been verified independently.




The Telegram bot and the worker should only be described as one complete
end-to-end system after the Telegram command path is explicitly wired to the
live worker.




For now, the accurate description is:




> Perpsia has a live Telegram product and a verified CMC Skill Hub worker
> prototype. The next step is to connect them through one production-ready
> execution path.

---




## Intelligence model




Perpsia uses three different responsibility layers.




### CoinMarketCap Skill Hub




Provides market research and structured market intelligence.




### Perpsia engine




Responsible for:




- classification;
- scoring;
- lifecycle;
- risk rules;
- meaningful-change detection;
- alert logic.




### OpenAI reasoning layer




Used for:




- explanation;
- contradiction analysis;
- natural-language interaction;
- report composition.




OpenAI may propose LONG, SHORT, or NEUTRAL from the supplied evidence and current web context, but PerpsIA's deterministic scoring and safety gates remain authoritative; OpenAI cannot independently approve an actionable trade.




---




## Risk management




Users can configure a personal risk profile:




```text
/risk 500 1 5
```




Example interpretation:




```text
Capital: $500
Risk per trade: 1%
Maximum leverage: 5x
```




Perpsia uses these settings to provide personalized risk information when a
relevant opportunity is identified.




---




## Autonomous scans




The live bot scheduler runs market scans every four hours.




```text
Scheduled scan
  -> candidate discovery
  -> asset analysis
  -> classification
  -> memory comparison
  -> meaningful-change detection
  -> Telegram alert
```




Alerts should only be sent when the system detects a meaningful change rather
than repeating the same information.




---




## Current architecture




### Live Telegram application




```text
Telegram user
      ↓
Intent router
      ↓
Perpsia services
      ↓
Market scan / asset analysis
      ↓
Memory and lifecycle
      ↓
Counter-thesis and risk
      ↓
Report composer
      ↓
Telegram response
```




### CMC Skill Hub worker prototype




```text
CLI worker
   ↓
MCP transport
   ↓
CMC Skill Hub
   ↓
find_skill / execute_skill
   ↓
Evidence admission
   ↓
Validation
   ↓
Structured research output
```




---




## Main technologies




### Live bot




- Node.js
- Telegram Bot API
- SQLite
- OpenAI API
- Render
- JavaScript services




### CMC worker prototype




- TypeScript
- CoinMarketCap Skill Hub MCP
- Streamable HTTP transport
- Zod validation
- Supabase-ready ingestion layer
- Dry-run and audit modes




### Frontend and branding




- Separate Perpsia landing page
- Dedicated product branding and visual identity




---




## Local bot setup




Create a `.env` file at the project root:




```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
OPENAI_API_KEY=
PERPSIA_DB_PATH=
PERFORMANCE_DASHBOARD_URL=
PERFORMANCE_CORS_ORIGIN=
ONCHAIN_RPC_URLS=
ONCHAIN_ASSET_REGISTRY=
ONCHAIN_EXCHANGE_ADDRESSES=
GMGN_ENABLED=false
GMGN_API_KEY=
GMGN_TIMEOUT_MS=8000
ALCHEMY_ENABLED=false
ALCHEMY_API_KEY=
ALCHEMY_TIMEOUT_MS=8000
ALCHEMY_NETWORKS=ethereum,base,arbitrum,bnb,polygon
ALCHEMY_WEBHOOK_SIGNING_KEY=
ALCHEMY_NOTIFY_AUTH_TOKEN=
ALCHEMY_WEBHOOK_URL=
ALCHEMY_SYNC_INTERVAL_MS=900000
BINANCE_REF_CODE=
BINANCE_REF_URL=
HYPERLIQUID_REF_CODE=
HYPERLIQUID_REF_URL=
BYBIT_REF_CODE=
BYBIT_REF_URL=
OKX_REF_CODE=
OKX_REF_URL=
```




Add any additional CMC Skill Hub or MCP configuration required by the local
worker implementation.




Never commit environment files or secrets.

### Trading-link configuration

Trade buttons are generated only when normalized provider evidence confirms that
the exact perpetual market exists. Binance, Bybit, OKX, and Hyperliquid are
supported. Empty referral variables keep normal direct market links active.

For the current Binance referral configuration, set these server-side values on
Render:

```text
BINANCE_REF_CODE=KPY12BIU
BINANCE_REF_URL=https://www.binance.com/register?ref=KPY12BIU
HYPERLIQUID_REF_CODE=
HYPERLIQUID_REF_URL=
BYBIT_REF_CODE=
BYBIT_REF_URL=
OKX_REF_CODE=
OKX_REF_URL=
```

PerpsIA never appends referral parameters to unsupported trading URLs. When a
validated venue-specific referral URL is unavailable, Binance uses the validated
registration fallback and the other venues use their normal direct market URL.




### Install




```bash
npm install
```




### Run




```bash
node index.js
```




### Syntax checks




```bash
node --check index.js
node --check services/scannerV2.js
node --check services/memory.js
node --check services/scheduler.js
node --check services/openaiReasoning.js
node --check services/intentRouter.js
node --check services/alertEngine.js
node --check services/riskEngine.js
node --check services/lifecycle.js
node --check services/decay.js
node --check services/counterThesis.js
node --check services/reportComposer.js
node --check services/rateLimit.js
node --check services/scanLock.js
npm test
```




---




## Security




Never commit:




```text
node_modules/
.env
.env.local
perpsia.db
*.db
*.sqlite
```




Recommended `.gitignore` entries:




```gitignore
node_modules/
.env
.env.local
perpsia.db
*.db
*.sqlite
```




Never expose:




- Telegram bot tokens;
- OpenAI API keys;
- Supabase service-role keys;
- MCP authorization headers;
- provider credentials.




---




## Development status




Perpsia V1 is a working product prototype.




### Verified




- Telegram service deployed on Render
- Health server running
- Four-hour scheduler running
- Telegram workflow implemented
- CMC Skill Hub live health check
- `find_skill` availability
- `execute_skill` availability
- live `altcoin_scanner_perp` execution
- live CMC evidence validation




### Operational notes


- SQLite history is durable only when PERPSIA_DB_PATH points to persistent storage.
- Public on-chain monitoring requires RPC access and exchange-address configuration for exchange-flow attribution.
- Performance results are paper-signal statistics, not audited investment returns.
---




## Integration proof




For technical verification, the following sequence demonstrates the live CMC
connection:




```bash
npm run worker -- cmc health --live
npm run worker -- cmc discover --dry-run --live
npm run worker -- cmc analyze --cmcid 5426 --dry-run --live
```




This section exists as technical verification only. It is not the main purpose
of the project.




---




## Roadmap




### Phase 1 — Consolidate V1




- keep the current live Telegram bot stable;
- preserve the existing landing page and branding;
- document the real architecture;
- separate verified functionality from planned functionality.




### Phase 2 — Perpsia V2 foundation




- create a clean backend repository;
- define provider-independent interfaces;
- connect Telegram to CMC Skill Hub through one production path;
- add structured logging and error handling.




### Phase 3 — Intelligence layer




- deterministic market classification;
- data freshness and quality scoring;
- contradiction and counter-thesis logic;
- personalized risk calculations;
- explainable outputs.




### Phase 4 — Persistence and evaluation




- scan history;
- opportunity lifecycle;
- alert history;
- paper-trading outcomes;
- MFE and MAE;
- model and rule evaluation.




### Phase 5 — Private beta




- onboard a small user group;
- measure usefulness and false positives;
- improve report quality;
- refine alerts before any trading execution feature.




---




## Disclaimer




Perpsia is a market intelligence and research tool.




It does not guarantee profits, predict market outcomes with certainty, or
replace independent research and risk management.




Nothing generated by Perpsia should be considered financial advice.

## HTTP endpoint access

`/api/signals` exposes only the current actionable signal feed for the landing page. The detailed `/metrics`, `/api/signal-quality`, `/api/performance/quality`, and `/api/performance/trades` endpoints require `PERPSIA_INTERNAL_API_TOKEN` using `Authorization: Bearer <token>`. Keep that token server-side; the landing proxy uses its separate `PERPSIA_API_TOKEN` variable and never exposes it to the browser.
