"use strict";

// Local/server-side wallet registry administration only.
// This file is intentionally a CLI entrypoint; it is not imported by the HTTP server.

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const admin = require("../services/walletAdmin");
const registry = require("../services/walletRegistry");

const HELP = `PerpsIA wallet admin (local/server-side only)

Usage:
  npm run wallet-admin -- <command> [options]

Commands:
  import-gmgn       Import explicitly classified GMGN wallets from a JSON file
  import-gmgn-smart-money  Discover and import qualified GMGN Smart Money wallets
  import-exchange   Import verified exchange wallets from a JSON file
  import-exchange-dataset  Alias for import-exchange
  import-kol        Import verified CT/KOL wallets from a JSON file
  import-funds      Import verified funds, market makers, treasuries, teams, or protocols
  add               Add or update one manually managed wallet
  list              List wallets; supports filters
  verify-pending    Show pending wallets for manual review (does not auto-approve)
  approve           Manually approve one wallet by id
  disable           Disable a wallet by numeric registry id
  enable            Enable a wallet by numeric registry id
  alchemy-sync      Synchronize enabled EVM wallets with Alchemy Address Activity
  alchemy-status    Show stored Alchemy synchronization status
  refresh-wallets   Refresh GMGN Smart Money and recalculate wallet quality
  history           Show one wallet and its stored onchain history

Common list filters:
  --category <name>       smart_money, kol, exchange_deposit, ...
  --exchange <name>
  --chain <name>
  --source <name>
  --quality-tier <tier>
  --min-priority <number>
  --enabled <true|false>
  --limit <number>

Examples:
  npm run wallet-admin -- list --category smart_money
  npm run wallet-admin -- list --exchange Binance
  npm run wallet-admin -- disable --id 12
  npm run wallet-admin -- alchemy-sync
  npm run wallet-admin -- alchemy-status
  npm run wallet-admin -- history --id 12 --lookback-hours 720
`;

function parseArgs(argv) {
  const values = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equal = raw.indexOf("=");
    if (equal !== -1) {
      values[raw.slice(0, equal)] = raw.slice(equal + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values[raw] = next;
      index += 1;
    } else {
      values[raw] = true;
    }
  }
  return { command: positional[0] || "help", values };
}

function value(values, ...names) {
  for (const name of names) {
    if (values[name] !== undefined) return values[name];
  }
  return undefined;
}

function required(values, name) {
  const result = value(values, name);
  if (result === undefined || result === "") throw new Error(`Missing required option --${name}.`);
  return result;
}

function numberOption(values, name, fallback) {
  const raw = value(values, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number.`);
  return parsed;
}

function booleanOption(values, name, fallback) {
  const raw = value(values, name);
  if (raw === undefined) return fallback;
  if (raw === true || raw === "true" || raw === "1") return true;
  if (raw === false || raw === "false" || raw === "0") return false;
  throw new Error(`--${name} must be true or false.`);
}

function readJsonFile(file) {
  const requested = path.resolve(String(file));
  const parsed = JSON.parse(fs.readFileSync(requested, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.wallets)) return parsed.wallets;
  if (Array.isArray(parsed.records)) return parsed.records;
  throw new Error(`${requested} must contain a JSON array, {"wallets": [...]}, or {"records": [...]}.`);
}

function listFilters(values) {
  const filters = {};
  for (const key of ["category", "exchange", "chain", "source", "address"]) {
    const item = value(values, key);
    if (item !== undefined) filters[key] = item;
  }
  if (value(values, "category")) filters.category = value(values, "category");
  if (value(values, "enabled") !== undefined) filters.enabled = booleanOption(values, "enabled", true);
  if (value(values, "limit") !== undefined) filters.limit = numberOption(values, "limit", 1000);
  if (value(values, "quality-tier", "qualityTier") !== undefined) filters.qualityTier = value(values, "quality-tier", "qualityTier");
  if (value(values, "min-priority", "minPriority") !== undefined) filters.minPriority = numberOption(values, "min-priority", 0);
  return filters;
}

function run(command, values) {
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    case "import-gmgn": {
      const records = readJsonFile(required(values, "file"));
      const result = admin.importGmgnWallets(records, {
        sourceUrl: value(values, "source-url", "sourceUrl"),
      });
      return result;
    }
    case "import-gmgn-smart-money":
      return admin.importGmgnSmartMoney({
        enabled: true,
        chain: value(values, "chain"),
        limit: numberOption(values, "limit", 100),
      });
    case "import-exchange":
    case "import-exchange-dataset":
    case "import-verified-exchange": {
      return admin.importVerifiedExchangeWallets(readJsonFile(required(values, "file")));
    }
    case "import-kol":
      return admin.importKols(readJsonFile(required(values, "file")));
    case "import-funds":
      return admin.importFunds(readJsonFile(required(values, "file")));
    case "add": {
      const input = {
        address: required(values, "address"),
        chain: required(values, "chain"),
        label: value(values, "label"),
        category: value(values, "category") || "tracked_wallet",
        source: value(values, "source") || "manual",
        sourceUrl: value(values, "source-url", "sourceUrl"),
        verificationStatus: value(values, "verification-status", "verificationStatus"),
        approvalStatus: value(values, "approval-status", "approvalStatus"),
        sourceConfidence: value(values, "source-confidence", "sourceConfidence"),
        notes: value(values, "notes"),
        publicIdentityReference: value(values, "public-identity-reference", "publicIdentityReference"),
        exchange: value(values, "exchange"),
        role: value(values, "role"),
        enabled: booleanOption(values, "enabled", true),
      };
      return admin.addWallet(input);
    }
    case "list":
      return admin.listWallets(listFilters(values));
    case "verify-pending":
      return admin.verifyPending();
    case "approve":
      return admin.approveWallet(required(values, "id"), value(values, "notes"));
    case "disable":
      return admin.disableWallet(required(values, "id"));
    case "enable":
      return admin.enableWallet(required(values, "id"));
    case "alchemy-sync":
      return admin.triggerAlchemySync({
        timeoutMs: numberOption(values, "timeout-ms", undefined),
        maxAddresses: numberOption(values, "max-addresses", undefined),
        minSyncPriority: numberOption(values, "min-priority", undefined),
        enabled: true,
      });
    case "alchemy-status":
    case "sync-status":
      return admin.inspectSyncStatus(value(values, "chain") ? { chain: value(values, "chain") } : {});
    case "refresh-wallets":
      return admin.refreshWallets({
        chains: value(values, "chains"),
        chain: value(values, "chain"),
        limit: numberOption(values, "limit", 100),
      });
    case "history":
      return admin.inspectWalletHistory(required(values, "id"), {
        lookbackHours: numberOption(values, "lookback-hours", 24 * 30),
        limit: numberOption(values, "limit", 1000),
      });
    default:
      throw new Error(`Unknown command: ${command}. Use --help for usage.`);
  }
}

async function main() {
  const { command, values } = parseArgs(process.argv.slice(2));
  const result = await run(command, values);
  if (result !== undefined) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`wallet-admin: ${error.message}\n`);
  process.exitCode = 1;
});
