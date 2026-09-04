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

CEX, DEX, sentiment, security, macro, and project credentials are read server-side only. Public CEX/DEX/Alternative.me/GoPlus/Honeypot calls do not require an API key. FRED requires FRED_API_KEY; GitHub works unauthenticated at its lower public limit and can use the server-only GITHUB_TOKEN for a higher limit.

/health reports the provider catalog, transport, current status, freshness-related failures, retry-after information, and circuit-breaker state. services/providers/streams.js provides public WebSocket subscriptions for high-frequency consumers; the Telegram scan remains request-bounded and uses the same normalized evidence contract.

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




OpenAI should not independently create or approve trading decisions.




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
