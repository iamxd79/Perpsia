const test = require("node:test");
const assert = require("node:assert/strict");

const { buildReasoningBrief } = require("../services/openaiReasoning");

test("does not require OpenAI credentials to load or start the application", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(await buildReasoningBrief({ signal: {} }), "");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
