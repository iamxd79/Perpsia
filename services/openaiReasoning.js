const OpenAI = require("openai");

let openai = null;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

async function buildReasoningBrief({ signal, lifecycle, decay, counter, memory }) {
  const client = getOpenAIClient();
  if (!client) {
    return "";
  }

  const response = await client.responses.create({
    model: "gpt-5.5",
    input: [
      {
        role: "system",
        content: `
You are Perpsia Reasoning Layer.

You are NOT the signal engine.
You are NOT allowed to create trades.

Use ONLY the provided JSON.

Never include:
- prices
- entries
- take-profits
- stop losses
- liquidity levels
- new targets
- new signals
- financial advice
- duplicated raw data

Do NOT change:
- category
- score
- direction
- lifecycle
- actionable status

Write only a short reasoning brief.

Format exactly:

Reasoning Summary:
...

Main Conflict:
...

What Would Change The View:
...

Final Read:
...

Keep it under 120 words.
        `,
      },
      {
        role: "user",
        content: JSON.stringify({
          signal: {
            symbol: signal.symbol,
            marketState: signal.marketState,
            category: signal.category,
            direction: signal.direction,
            score: signal.score,
            isActionable: signal.isActionable,
            reasons: signal.reasons,
            confirmationNeeded: signal.confirmationNeeded,
            evidence: signal.evidence,
            conflicts: signal.conflicts,
          },
          lifecycle,
          decay,
          counter: {
            risks: counter?.risks,
            finalDecision: counter?.finalDecision,
          },
          memory,
        }),
      },
    ],
  });

  return response.output_text || "";
}

module.exports = {
  buildReasoningBrief,
};
