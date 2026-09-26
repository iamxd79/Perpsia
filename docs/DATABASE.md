# PerpsIA database migration

## Current policy

SQLite remains the operational backend while the PostgreSQL boundary is validated in staging. This is deliberate: the Telegram command path is synchronous and currently depends on SQLite reads/writes. A partial runtime cutover would create two sources of truth.

PostgreSQL is the long-term product database. The repository contains versioned SQL migrations under `migrations/`, a small `pg` connection boundary, and account overview/history repository methods. The future cutover should switch the domain repositories together, after reconciliation, rather than switching individual tables ad hoc.

## Environments

Set one of these on the backend, without committing secrets:

```env
PERPSIA_DATABASE_URL=postgresql://...
# or Supabase's direct database URL
SUPABASE_DB_URL=postgresql://...
PERPSIA_DATABASE_SSL=true
```

`PERPSIA_DB_PATH=/var/data/perpsia.db` remains the Render SQLite compatibility path until staging validation is complete.

## Migrations

Preview pending files:

```bash
node scripts/db-migrate.js --dry-run
```

Apply them to the configured PostgreSQL database:

```bash
node scripts/db-migrate.js
```

The runner creates `schema_migrations`, applies files in lexical version order, and wraps each file in a transaction. It is safe to rerun.

## SQLite migration

The migration tool is dry-run by default and reports orphaned/ambiguous records. It never deletes or mutates SQLite:

```bash
node scripts/migrate-sqlite-to-postgres.js
```

After reviewing the report, apply only against a prepared staging database:

```bash
node scripts/migrate-sqlite-to-postgres.js --apply
```

The current tool migrates accounts, identities, wallets, preferences, risk profiles, watchlists, paper positions, account alerts, analysis history, and usage events. Global market intelligence tables stay in SQLite because they are not owned by a PerpsIA account. Orphaned legacy rows are reported as conflicts and are not copied.

## Cutover checklist

1. Snapshot the Render SQLite database and run a dry-run report.
2. Apply migrations to a staging Supabase/PostgreSQL project.
3. Apply the migration tool and compare counts plus conflict report.
4. Run account, wallet, Telegram and web consistency tests against staging.
5. Enable PostgreSQL for staging only and observe reconnect/error metrics.
6. Repeat the snapshot/report/reconciliation process for production.
7. Keep SQLite read-only rollback material until the PostgreSQL cutover is stable.
