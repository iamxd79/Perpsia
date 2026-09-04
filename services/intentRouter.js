const OpenAI = require("openai");
const { normalizeVenue } = require("./exchangeAdapter");

let openai = null;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

function normalizeSymbol(value) {
  return String(value || "").replace(/^\$/, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function routeIntentLocally(text) {
  const input = String(text || "").trim();
  if (!input) return null;

  let match = input.match(/\bcompare\s+\$?([a-z0-9]+)\s+(?:and|vs\.?|with)\s+\$?([a-z0-9]+)\b/i);
  if (match) return { intent: "compare_assets", symbols: [normalizeSymbol(match[1]), normalizeSymbol(match[2])], confidence: 1 };

  match = input.match(/\b(?:track|watch)\s+\$?([a-z0-9]+)\b/i);
  if (match) return { intent: "watchlist_add", symbol: normalizeSymbol(match[1]), confidence: 1 };

  match = input.match(/\bhow\s+has\s+\$?([a-z0-9]+)\s+changed|\bhistory\s+(?:for\s+)?\$?([a-z0-9]+)/i);
  if (match) return { intent: "history", symbol: normalizeSymbol(match[1] || match[2]), confidence: 1 };

  match = input.match(/\b(?:early\s+alpha|alpha)(?:\s+(?:for\s+)?\$?([a-z0-9]+))?\b/i);
  if (match) return { intent: "alpha", symbol: normalizeSymbol(match[1]), confidence: 1 };

  match = input.match(/\b(?:analyze|analyse|review|check)\s+\$?([a-z0-9]+)(?:\s+(?:on\s+)?(binance|bybit|okx|okex|hyperliquid|hl|dydx))?\b/i);
  if (match) {
    let venue = null;
    if (match[2]) {
      try {
        venue = normalizeVenue(match[2]);
      } catch {}
    }
    return { intent: "analyze_asset", symbol: normalizeSymbol(match[1]), venue, confidence: 1 };
  }

  if (/\bscan\b.*\bmarket\b|\bfind\b.*\b(?:setups|trades|opportunities)\b/i.test(input)) {
    const venueMatch = input.match(/\b(?:on\s+)?(binance|bybit|okx|okex|hyperliquid|hl|dydx)\b/i);
    let venue = null;
    if (venueMatch) {
      try {
        venue = normalizeVenue(venueMatch[1]);
      } catch {}
    }
    return { intent: "scan_market", venue, confidence: 1 };
  }

  const capital = input.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  const risk = input.match(/\brisk(?:ing)?(?:\s+per\s+trade)?\s*(?:of\s*)?([0-9]+(?:\.[0-9]+)?)\s*%/i);
  const leverage = input.match(/(?:max(?:imum)?\s+)?leverage\s*(?:of\s*)?([0-9]+(?:\.[0-9]+)?)\s*x?|([0-9]+(?:\.[0-9]+)?)\s*x\s+(?:max(?:imum)?\s+)?leverage/i);
  if (capital && risk) {
    return {
      intent: "set_risk",
      capital: Number(capital[1]),
      riskPercent: Number(risk[1]),
      maxLeverage: leverage ? Number(leverage[1] || leverage[2]) : null,
      confidence: 1,
    };
  }

  if (/\bperformance|win\s*rate|signal results\b/i.test(input)) return { intent: "performance", confidence: 1 };
  if (/\bsettings|preferences\b/i.test(input)) return { intent: "settings", confidence: 1 };
  if (/\bwatchlist|tracked assets\b/i.test(input)) return { intent: "watchlist", confidence: 1 };
  if (/\bstatus|are you online|system health\b/i.test(input)) return { intent: "status", confidence: 1 };
  if (/\bhelp|commands|what can you do\b/i.test(input)) return { intent: "help", confidence: 1 };
  if (/\babout perpsia|what is perpsia\b/i.test(input)) return { intent: "about", confidence: 1 };
  return null;
}

async function routeIntent(text) {
  const localRoute = routeIntentLocally(text);
  if (localRoute) return localRoute;

  const client = getOpenAIClient();
  if (!client) {
    return {
      intent: "unknown",
      confidence: 0,
    };
  }

  const response = await client.responses.create({
    model: "gpt-5.5",
    input: [
      {
        role: "system",
        content: `
You are Perpsia Intent Router.

Return ONLY valid JSON.
No markdown.
No explanation.

Possible intents:
- analyze_asset
- scan_market
- set_risk
- alpha
- compare_assets
- watchlist
- watchlist_add
- history
- performance
- settings
- about
- status
- help
- conversation
- unknown

Rules:
- If the user greets, thanks, jokes, or casually talks, return conversation.
- If user asks what you can do, return help.
- If user asks to analyze, check, review, scan, or inspect ONE asset, return analyze_asset.
- Extract crypto/futures symbol in uppercase.
- Default venue is Binance unless the user mentions another supported venue.
- Supported venues are Binance, Bybit, OKX, Dydx, and Hyperliquid.
- Normalize venue aliases such as okex to OKX and dydxv4 to Dydx. Return the canonical name.
- If user asks to scan the whole market or find opportunities, return scan_market.
- If user asks for early alpha, return alpha and extract a symbol when supplied.
- If user compares two assets, return compare_assets and include symbols as a two-item uppercase array.
- If user asks to track an asset, return watchlist_add.
- If user asks how an asset changed or asks for past analyses, return history.
- If user gives capital/risk/leverage settings, return set_risk.
- If unclear, return unknown.

JSON schema:
{
  "intent": "conversation",
  "symbol": null,
  "symbols": [],
  "venue": "Binance",
  "capital": null,
  "riskPercent": null,
  "maxLeverage": null,
  "reply": "short natural reply",
  "confidence": 0.9
}
        `,
      },
      {
        role: "user",
        content: text,
      },
    ],
  });

  try {
    const route = JSON.parse(response.output_text);

    if (route.venue) {
      try {
        route.venue = normalizeVenue(route.venue);
      } catch {
        route.venue = "Binance";
      }
    }

    return route;
  } catch {
    return {
      intent: "unknown",
      confidence: 0,
    };
  }
}

module.exports = {
  routeIntent,
  routeIntentLocally,
};
