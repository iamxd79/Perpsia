const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const LOCAL_DATABASE_PATH = path.join(__dirname, "..", "perpsia.db");
const configuredDatabasePath = String(process.env.PERPSIA_DB_PATH || "").trim();
const DATABASE_PATH = path.resolve(
  configuredDatabasePath || LOCAL_DATABASE_PATH
);
const PERSISTENT_DISK_ROOT = path.resolve("/var/data");
const persistentDiskPath =
  DATABASE_PATH === PERSISTENT_DISK_ROOT ||
  DATABASE_PATH.startsWith(PERSISTENT_DISK_ROOT + path.sep);

let migratedLegacyDatabase = false;

function migrateLegacyDatabaseIfNeeded() {
  if (!configuredDatabasePath) return;
  if (DATABASE_PATH === path.resolve(LOCAL_DATABASE_PATH)) return;
  if (fs.existsSync(DATABASE_PATH)) return;
  if (!fs.existsSync(LOCAL_DATABASE_PATH)) return;

  fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });

  const legacyDatabase = new Database(LOCAL_DATABASE_PATH);
  try {
    legacyDatabase.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    legacyDatabase.close();
  }

  fs.copyFileSync(LOCAL_DATABASE_PATH, DATABASE_PATH);
  migratedLegacyDatabase = true;
}

migrateLegacyDatabaseIfNeeded();

function openDatabase() {
  fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  const database = new Database(DATABASE_PATH);
  database.pragma("journal_mode = WAL");
  return database;
}

function getStorageInfo() {
  return {
    backend: "sqlite",
    path: DATABASE_PATH,
    persistent: persistentDiskPath,
    journal_mode: "WAL",
    sidecar_directory: path.dirname(DATABASE_PATH),
    wal_path: DATABASE_PATH + "-wal",
    shm_path: DATABASE_PATH + "-shm",
    migrated_legacy_database: migratedLegacyDatabase,
    warning: persistentDiskPath
      ? null
      : "SQLite is using the local service filesystem; set PERPSIA_DB_PATH to /var/data/perpsia.db on Render.",
  };
}

module.exports = {
  LOCAL_DATABASE_PATH,
  DATABASE_PATH,
  openDatabase,
  getStorageInfo,
};
