const OpenAI = require("openai");
const { normalizeVenue } = require("./exchangeAdapter");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function routeIntent(text) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      intent: "unknown",
      confidence: 0,
    };
  }

  const response = await openai.responses.create({
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
- If user gives capital/risk/leverage settings, return set_risk.
- If unclear, return unknown.

JSON schema:
{
  "intent": "conversation",
  "symbol": null,
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
};
