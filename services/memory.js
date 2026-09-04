const { openDatabase, getStorageInfo } = require("./database");


// ==========================================
// PERPSIA MEMORY ENGINE
// ==========================================


const db = openDatabase();


db.pragma("journal_mode = WAL");


// ==========================================
// TABLES
// ==========================================


db.exec(`
  CREATE TABLE IF NOT EXISTS asset_states (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    market_state TEXT,
    category TEXT,
    direction TEXT,
    lifecycle_stage TEXT,
    score INTEGER,
    price REAL,
    price_change REAL,
    oi_change REAL,
    funding REAL,
    raw_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    alert_type TEXT,
    message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_risk_settings (
    chat_id TEXT PRIMARY KEY,
    capital REAL,
    risk_percent REAL,
    max_leverage REAL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_watchlist (
    chat_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chat_id, symbol)
  );

  CREATE TABLE IF NOT EXISTS user_preferences (
    chat_id TEXT PRIMARY KEY,
    preferred_exchange TEXT NOT NULL DEFAULT 'Binance',
    alert_frequency TEXT NOT NULL DEFAULT '4h',
    signal_sensitivity TEXT NOT NULL DEFAULT 'balanced',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);


// Migration for older database
try {
  db.prepare(`
    ALTER TABLE asset_states
    ADD COLUMN lifecycle_stage TEXT
  `).run();
} catch {}


// ==========================================
// ASSET STATE
// ==========================================


function saveAssetState(signal) {
  const stmt = db.prepare(`
    INSERT INTO asset_states (
      symbol,
      market_state,
      category,
      direction,
      lifecycle_stage,
      score,
      price,
      price_change,
      oi_change,
      funding,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);


  return stmt.run(
    signal.symbol.toUpperCase(),
    signal.marketState,
    signal.category,
    signal.direction,
    signal.lifecycleStage || null,
    signal.score,
    signal.price,
    signal.priceChange,
    signal.oiChange,
    signal.funding,
    JSON.stringify(signal)
  );
}


function getLastAssetState(symbol) {
  return db
    .prepare(`
      SELECT *
      FROM asset_states
      WHERE symbol = ?
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(symbol.toUpperCase());
}


function getAssetHistory(symbol, limit = 10) {
  return db
    .prepare(`
      SELECT *
      FROM asset_states
      WHERE symbol = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(symbol.toUpperCase(), limit);
}


function compareAssetState(previous, current) {
  if (!previous) {
    return {
      isNew: true,
      hasMeaningfulChange: true,
      summary: "First recorded analysis for this asset.",
      changes: [],
    };
  }


  const changes = [];


  if (previous.market_state !== current.marketState) {
    changes.push(`Market State: ${previous.market_state} → ${current.marketState}`);
  }


  if (previous.category !== current.category) {
    changes.push(`Category: ${previous.category} → ${current.category}`);
  }


  if (previous.direction !== current.direction) {
    changes.push(`Direction: ${previous.direction} → ${current.direction}`);
  }


  if (previous.lifecycle_stage !== current.lifecycleStage) {
    changes.push(`Lifecycle: ${previous.lifecycle_stage || "NONE"} → ${current.lifecycleStage}`);
  }


  const previousScore = Number(previous.score);
  const currentScore = Number(current.score);
  const scoreDiff = currentScore - previousScore;


  if (scoreDiff !== 0) {
    changes.push(
      `Score: ${previousScore} → ${currentScore} (${scoreDiff > 0 ? "+" : ""}${scoreDiff})`
    );
  }


  if (previous.price !== null && current.price !== null) {
    const priceDifference = current.price - previous.price;
    const pricePercentChange =
      previous.price !== 0 ? ((priceDifference / previous.price) * 100).toFixed(2) : 0;


    if (Math.abs(Number(pricePercentChange)) >= 2) {
      changes.push(`Price moved ${pricePercentChange}% since previous analysis`);
    }
  }


  if (previous.oi_change !== null && current.oiChange !== null) {
    const oiDifference = current.oiChange - previous.oi_change;


    if (Math.abs(oiDifference) >= 10) {
      changes.push(`OI momentum changed by ${oiDifference.toFixed(2)} percentage points`);
    }
  }


  return {
    isNew: false,
    hasMeaningfulChange: changes.length > 0,
    summary: changes.length
      ? "Meaningful market change detected."
      : "No meaningful change since last analysis.",
    changes,
  };
}


// ==========================================
// ALERTS
// ==========================================


function saveAlert(symbol, alertType, message) {
  return db
    .prepare(`
      INSERT INTO alerts (
        symbol,
        alert_type,
        message
      ) VALUES (?, ?, ?)
    `)
    .run(symbol.toUpperCase(), alertType, message);
}


function getLastAlert(symbol) {
  return db
    .prepare(`
      SELECT *
      FROM alerts
      WHERE symbol = ?
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(symbol.toUpperCase());
}


// ==========================================
// RISK SETTINGS
// ==========================================


function saveRiskSettings(chatId, capital, riskPercent, maxLeverage) {
  return db
    .prepare(`
      INSERT INTO user_risk_settings (
        chat_id,
        capital,
        risk_percent,
        max_leverage,
        updated_at
      )
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id)
      DO UPDATE SET
        capital = excluded.capital,
        risk_percent = excluded.risk_percent,
        max_leverage = excluded.max_leverage,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run(String(chatId), capital, riskPercent, maxLeverage);
}


function getRiskSettings(chatId) {
  return db
    .prepare(`
      SELECT *
      FROM user_risk_settings
      WHERE chat_id = ?
    `)
    .get(String(chatId));
}


// ==========================================
// WATCHLIST AND USER PREFERENCES
// ==========================================


function normalizeTrackedSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}


function getWatchlist(chatId) {
  return db
    .prepare(`
      SELECT symbol, created_at
      FROM user_watchlist
      WHERE chat_id = ?
      ORDER BY created_at ASC, symbol ASC
    `)
    .all(String(chatId));
}


function addToWatchlist(chatId, symbol) {
  const normalized = normalizeTrackedSymbol(symbol);
  if (!normalized) throw new Error("A valid asset symbol is required.");
  return db
    .prepare(`
      INSERT OR IGNORE INTO user_watchlist (chat_id, symbol)
      VALUES (?, ?)
    `)
    .run(String(chatId), normalized);
}


function removeFromWatchlist(chatId, symbol) {
  const normalized = normalizeTrackedSymbol(symbol);
  if (!normalized) throw new Error("A valid asset symbol is required.");
  return db
    .prepare(`
      DELETE FROM user_watchlist
      WHERE chat_id = ? AND symbol = ?
    `)
    .run(String(chatId), normalized);
}


function getUserPreferences(chatId) {
  return db
    .prepare(`
      SELECT chat_id, preferred_exchange, alert_frequency, signal_sensitivity, updated_at
      FROM user_preferences
      WHERE chat_id = ?
    `)
    .get(String(chatId)) || {
      chat_id: String(chatId),
      preferred_exchange: "Binance",
      alert_frequency: "4h",
      signal_sensitivity: "balanced",
      updated_at: null,
    };
}


function saveUserPreferences(chatId, updates = {}) {
  const current = getUserPreferences(chatId);
  const preferredExchange = String(updates.preferred_exchange || updates.preferredExchange || current.preferred_exchange || "Binance");
  const alertFrequency = String(updates.alert_frequency || updates.alertFrequency || current.alert_frequency || "4h");
  const signalSensitivity = String(updates.signal_sensitivity || updates.signalSensitivity || current.signal_sensitivity || "balanced");

  db.prepare(`
    INSERT INTO user_preferences (
      chat_id,
      preferred_exchange,
      alert_frequency,
      signal_sensitivity,
      updated_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id)
    DO UPDATE SET
      preferred_exchange = excluded.preferred_exchange,
      alert_frequency = excluded.alert_frequency,
      signal_sensitivity = excluded.signal_sensitivity,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    String(chatId),
    preferredExchange,
    alertFrequency,
    signalSensitivity
  );

  return getUserPreferences(chatId);
}


// ==========================================
// STATS
// ==========================================


function getMemoryStats() {
  const totalStates = db
    .prepare(`SELECT COUNT(*) AS count FROM asset_states`)
    .get().count;


  const trackedAssets = db
    .prepare(`SELECT COUNT(DISTINCT symbol) AS count FROM asset_states`)
    .get().count;


  const totalAlerts = db
    .prepare(`SELECT COUNT(*) AS count FROM alerts`)
    .get().count;


  return {
    totalStates,
    trackedAssets,
    totalAlerts,
  };
}


module.exports = {
  saveAssetState,
  getLastAssetState,
  getAssetHistory,
  compareAssetState,
  saveAlert,
  getLastAlert,
  saveRiskSettings,
  getRiskSettings,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getUserPreferences,
  saveUserPreferences,
  getMemoryStats,
  getStorageInfo,
};
