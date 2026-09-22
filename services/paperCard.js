const sharp = require("sharp");

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function money(value, digits = 2) {
  return "$" + finite(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function calculatePnl(position) {
  const entry = finite(position.entry_price);
  const mark = finite(position.mark_price);
  const quantity = finite(position.quantity);
  const pnl = position.direction === "SHORT" ? (entry - mark) * quantity : (mark - entry) * quantity;
  const margin = finite(position.margin);
  return { pnl, percent: margin ? (pnl / margin) * 100 : 0 };
}

function renderSvg(position) {
  const { pnl, percent } = calculatePnl(position);
  const positive = pnl >= 0;
  const accent = positive ? "#51e6a7" : "#ff6f91";
  const directionColor = position.direction === "LONG" ? "#55c8ff" : "#ff9a76";
  const symbol = escapeXml(String(position.symbol || "").replace(/USDT$/, ""));
  const direction = escapeXml(position.direction || "PAPER");
  const source = escapeXml(position.venue || "Public exchange data");
  const pnlText = (positive ? "+" : "") + money(pnl);
  const percentText = (positive ? "+" : "") + percent.toFixed(2) + "%";
  const markX = Math.max(170, Math.min(1030, 600 + Math.max(-1, Math.min(1, percent / 10)) * 300));

  return `<svg width="1200" height="675" viewBox="0 0 1200 675" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0d1928"/><stop offset="0.55" stop-color="#142c43"/><stop offset="1" stop-color="#102019"/></linearGradient>
      <linearGradient id="glow" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${accent}" stop-opacity="0.28"/><stop offset="1" stop-color="#53a6ff" stop-opacity="0.05"/></linearGradient>
      <filter id="blur"><feGaussianBlur stdDeviation="42"/></filter>
    </defs>
    <rect width="1200" height="675" rx="38" fill="url(#bg)"/>
    <circle cx="1030" cy="90" r="170" fill="${accent}" opacity="0.16" filter="url(#blur)"/>
    <circle cx="170" cy="610" r="150" fill="#278cff" opacity="0.12" filter="url(#blur)"/>
    <rect x="28" y="28" width="1144" height="619" rx="30" fill="url(#glow)" stroke="#ffffff" stroke-opacity="0.2" stroke-width="2"/>
    <text x="72" y="86" fill="#8bb9d9" font-family="Arial, sans-serif" font-size="22" font-weight="700" letter-spacing="4">PERPSIA PAPER TRADE</text>
    <text x="72" y="166" fill="#ffffff" font-family="Arial, sans-serif" font-size="64" font-weight="800">${symbol}USDT</text>
    <rect x="850" y="112" width="250" height="64" rx="32" fill="${directionColor}" fill-opacity="0.18" stroke="${directionColor}" stroke-opacity="0.7"/>
    <text x="975" y="154" text-anchor="middle" fill="${directionColor}" font-family="Arial, sans-serif" font-size="27" font-weight="800">${direction} · ${finite(position.leverage)}x</text>
    <text x="72" y="218" fill="#9db5c8" font-family="Arial, sans-serif" font-size="22">Live simulated position · ${source}</text>
    <rect x="72" y="260" width="1056" height="144" rx="24" fill="#08121e" fill-opacity="0.42" stroke="#ffffff" stroke-opacity="0.12"/>
    <text x="110" y="305" fill="#8fa8bb" font-family="Arial, sans-serif" font-size="20">ENTRY</text>
    <text x="110" y="352" fill="#ffffff" font-family="Arial, sans-serif" font-size="34" font-weight="700">${money(position.entry_price)}</text>
    <text x="410" y="305" fill="#8fa8bb" font-family="Arial, sans-serif" font-size="20">MARK</text>
    <text x="410" y="352" fill="#ffffff" font-family="Arial, sans-serif" font-size="34" font-weight="700">${money(position.mark_price)}</text>
    <text x="710" y="305" fill="#8fa8bb" font-family="Arial, sans-serif" font-size="20">MARGIN</text>
    <text x="710" y="352" fill="#ffffff" font-family="Arial, sans-serif" font-size="34" font-weight="700">${money(position.margin)}</text>
    <text x="1010" y="305" fill="#8fa8bb" font-family="Arial, sans-serif" font-size="20">STATUS</text>
    <text x="1010" y="352" fill="${accent}" font-family="Arial, sans-serif" font-size="27" font-weight="700">${escapeXml(position.status || "OPEN")}</text>
    <text x="72" y="484" fill="#8fa8bb" font-family="Arial, sans-serif" font-size="22">UNREALIZED PNL</text>
    <text x="72" y="555" fill="${accent}" font-family="Arial, sans-serif" font-size="66" font-weight="800">${pnlText}</text>
    <text x="390" y="548" fill="${accent}" font-family="Arial, sans-serif" font-size="30" font-weight="700">(${percentText})</text>
    <line x1="700" y1="518" x2="1070" y2="518" stroke="#ffffff" stroke-opacity="0.18" stroke-width="4"/>
    <line x1="700" y1="518" x2="${markX}" y2="518" stroke="${accent}" stroke-width="8" stroke-linecap="round"/>
    <circle cx="${markX}" cy="518" r="13" fill="${accent}"/>
    <text x="700" y="570" fill="#8fa8bb" font-family="Arial, sans-serif" font-size="18">SL ${money(position.stop_loss)}   ·   TP ${money(position.take_profit)}</text>
    <text x="72" y="615" fill="#66859c" font-family="Arial, sans-serif" font-size="18">Paper trading only — no real orders were sent.</text>
    <text x="1128" y="615" text-anchor="end" fill="#66859c" font-family="Arial, sans-serif" font-size="18">PerpsIA</text>
  </svg>`;
}

async function renderPaperPnlCard(position) {
  return sharp(Buffer.from(renderSvg(position))).png().toBuffer();
}

module.exports = { renderPaperPnlCard, renderSvg };
