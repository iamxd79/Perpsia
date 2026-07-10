# Perpsia V1

Perpsia V1 is an auditable perpetual-futures research and setup-ranking
terminal.

The product combines:

- a database-backed setup terminal;
- constrained lifecycle tracking;
- Telegram alerts;
- scheduled background services;
- a live CoinMarketCap Skill Hub MCP bridge;
- evidence validation before provider output can be used by Perpsia.

Live provider output is treated as research evidence. It cannot directly create
entries, stop-losses, targets, scores, lifecycle states, or trade outcomes.

## Current status

As of July 10, 2026, the following live CMC Skill Hub flow has been verified:

```text
Perpsia worker
  -> MCP bridge
  -> CMC Skill Hub
  -> find_skill
  -> execute_skill
  -> altcoin_scanner_perp / perp_contract_analysis
  -> Perpsia evidence validation
  -> structured research output
```

The verified live health check returns:

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

A live, no-write discovery run has also been verified with:

```bash
npm run worker -- cmc discover --dry-run --live
```

The response included:

- a successful validation result;
- `rawSkillId: altcoin_scanner_perp`;
- a CoinMarketCap-branded decision report;
- a ranked perpetual-altcoin research queue;
- provider-envelope admission and field-renaming metadata.

This confirms that Perpsia is executing a real CMC Skill Hub skill rather than
reading a local fixture.

## Product boundaries

Perpsia V1 separates provider evidence from Perpsia-owned trade logic.

```text
External provider
  -> raw response
  -> admission mapping
  -> evidence validation
  -> normalized evidence

Normalized evidence
  -> Perpsia-owned signal engine
  -> setup interpretation
  -> scoring
  -> lifecycle
  -> alerts
```

The Perpsia-owned signal engine remains disabled for live provider evidence
until its deterministic trade interpretation is implemented and approved.

Therefore:

- CMC output can support research;
- CMC output cannot directly create a trade setup;
- provider confidence is stored only as provider context;
- provider action guidance is removed from admitted evidence;
- the live CMC path is safe by default and uses no-write mode unless an explicit
  persistence mode is selected.

## Stack

- Next.js 16
- React 19
- TypeScript
- Supabase PostgreSQL
- Supabase JavaScript client with server-side service-role access
- Telegram Bot API
- Vercel Cron
- Render runtime for the deployed Telegram service
- CMC Skill Hub through a Streamable HTTP MCP bridge
- Zod-based validation

## Repository architecture

```text
app/
  Next.js routes and database-backed product pages

lib/cmc/
  CMC Skill Hub adapter, transport, schemas, validation, and normalization

lib/worker/
  ingestion execution, repositories, retries, leases, and audit logic

lib/signal-engine/
  Perpsia-owned interpretation boundary

scripts/perpsia-worker.ts
  CLI entry point for live CMC, fixture, replay, database, and provider commands

bridges/
  local MCP bridge adapters

supabase/
  PostgreSQL migrations and database configuration
```

## Live CMC Skill Hub commands

### Health check

```bash
npm run worker -- cmc health --live
```

This verifies:

- the MCP transport;
- the availability of `find_skill`;
- the availability of `execute_skill`;
- the discovery skill `altcoin_scanner_perp`;
- the analysis skill `perp_contract_analysis`.

### Market discovery

```bash
npm run worker -- cmc discover --dry-run --live
```

This executes the live discovery skill and validates the returned research
evidence without writing snapshots to Supabase.

### Single-asset analysis

SOL example:

```bash
npm run worker -- cmc analyze --cmcid 5426 --dry-run --live
```

The worker uses `perp_contract_analysis` for the requested asset.

### Batch flow

```bash
npm run worker -- cmc run --max-candidates 10 --dry-run --live
```

### Database verification

```bash
npm run worker -- cmc verify-db
```

This requires the ingestion migrations and valid Supabase service-role
configuration.

## CMC evidence admission

The live provider envelope passes through a versioned admission layer.

Current behavior includes:

- renaming provider `confidence` to `provider_analysis_confidence`;
- removing provider action guidance;
- retaining provenance and source timestamps;
- preserving the raw skill identifier for auditability;
- rejecting forbidden trade-authority fields;
- validating admitted evidence before normalization.

CMC Skill Hub remains an evidence source, not Perpsia's signal authority.

## Ingestion worker

The provider-neutral worker foundation includes:

- atomic worker leases;
- ingestion run tracking;
- idempotent source requests;
- raw source artifact retention;
- validation-failure persistence;
- source-health persistence;
- deterministic idempotency hashing;
- bounded retries;
- secret redaction;
- no-write and audit-write dry-run policies;
- fixture replay;
- raw-artifact replay.

The worker repository boundary exposes ingestion and provider-evidence
operations only. It does not expose setup, score, transition, or outcome
writers.

### General worker examples

```bash
npm run worker -- fixture tests/fixtures/cmc-perp-evidence.json
npm run worker -- fixture tests/fixtures/cmc-perp-evidence.json audit-write
npm run worker -- validate tests/fixtures/cmc-perp-evidence.json
npm run worker -- health
```

Fixture and replay commands are no-write by default.

Use:

- `--dry-run` or the default mode for no writes;
- `audit-write` to persist audit records only;
- `commit` only where snapshot persistence is explicitly supported.

## Local setup

1. Copy `.env.example` to `.env.local`.

2. Configure the required environment variables:

   ```text
   SUPABASE_URL
   SUPABASE_SERVICE_ROLE_KEY
   TELEGRAM_BOT_TOKEN
   CRON_SECRET
   SETTINGS_WRITE_SECRET
   ```

3. Apply the database migrations:

   ```bash
   npm run db:push
   ```

   For a local Supabase stack:

   ```bash
   npm run db:start
   npm run db:reset
   ```

4. Optionally insert clearly labeled development records:

   ```bash
   npm run db:seed
   ```

5. Start the application:

   ```bash
   npm run dev
   ```

Without valid Supabase configuration, the product deliberately shows a
connection setup state. It does not substitute hardcoded production data.

## Development-data warning

The seed script creates demonstration assets, snapshots, setups, evidence,
transitions, and outcomes.

All seeded records are marked as development data.

Seeded values must not be presented as live CMC output or live trading
performance.

## Scheduled jobs

`vercel.json` configures:

- `/api/cron/scan` every 15 minutes;
- `/api/cron/alerts` every 5 minutes.

Both require:

```text
Authorization: Bearer <CRON_SECRET>
```

The scheduled scanner acts as an orchestrator:

1. Live provider evidence is kept separate from setup authority.
2. Provider evidence cannot create setups directly.
3. Existing Perpsia setups can be evaluated against persisted authoritative
   price snapshots.
4. Legal lifecycle transitions are applied through an atomic PostgreSQL
   function.
5. PostgreSQL creates alert-queue rows only after allowed transitions are
   persisted.

The alert worker never invents transitions.

## Telegram

Set `TELEGRAM_BOT_TOKEN`, configure an authorized Telegram chat or subscription,
and set `SETTINGS_WRITE_SECRET` before enabling settings writes.

The deployed Telegram service and scheduler can run independently from the CMC
worker. A complete user-request-to-CMC-to-Telegram flow should only be claimed
where the bot command is explicitly wired to the live worker.

## Contest demonstration

A transparent proof of the CMC integration should show:

1. `npm run worker -- cmc health --live`
2. `status: HEALTHY`
3. `find_skill`
4. `execute_skill`
5. `altcoin_scanner_perp`
6. `perp_contract_analysis`
7. `npm run worker -- cmc discover --dry-run --live`
8. `rawSkillId: altcoin_scanner_perp`
9. the returned CoinMarketCap research output
10. Perpsia's validation and admission metadata

Recommended public description:

> Perpsia connects to CoinMarketCap Skill Hub through a live MCP bridge. The
> worker verifies the available CMC tools, executes the relevant research
> skill, validates the returned evidence, and keeps provider output separate
> from Perpsia-owned trade logic.

## Documentation

- [CMC Skill Hub ingestion contract](docs/CMC_SKILL_HUB_INGESTION.md)
- [Phase 2A worker configuration](docs/CMC_WORKER_PHASE2A.md)
- [Phase 2B live MCP bridge](docs/CMC_WORKER_PHASE2B.md)
- [Phase 2C envelope admission](docs/CMC_WORKER_PHASE2C.md)
- [Phase 2D persistence and replay](docs/CMC_WORKER_PHASE2D.md)
- [Phase 2E evidence extraction](docs/CMC_WORKER_PHASE2E.md)

## Verification

```bash
npm run typecheck
npm run build
```

The seed command and persistence modes require a configured Supabase project.
This repository does not contain credentials.
