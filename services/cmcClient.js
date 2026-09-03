require("dotenv").config();

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const {
  executeWithResilience,
} = require("./resilience");
const {
  recordCmcError,
  recordCmcRequest,
  structuredLog,
} = require("./telemetry");

async function createCmcClient() {
  const endpoint = process.env.CMC_MCP_ENDPOINT;
  const apiKey = process.env.CMC_API_KEY;

  if (!endpoint) {
    throw new Error("CMC_MCP_ENDPOINT missing from .env");
  }

  if (!apiKey) {
    throw new Error("CMC_API_KEY missing from .env");
  }

  const transport = new StreamableHTTPClientTransport(
    new URL(endpoint),
    {
      requestInit: {
        headers: {
          "X-CMC-MCP-API-KEY": apiKey,
        },
      },
    }
  );

  const client = new Client(
    {
      name: "perpsia-terminal",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);
  return client;
}

function providerError(result) {
  const textBlock = result?.content?.find((item) => item.type === "text");
  const error = new Error(
    "CMC Skill Hub error: " +
    (textBlock?.text || "The provider returned an MCP tool error.")
  );
  error.code = "CMC_PROVIDER_ERROR";
  return error;
}

async function callToolOnce(toolName, argumentsObject, timeout) {
  const client = await createCmcClient();

  try {
    const result = await client.callTool(
      {
        name: toolName,
        arguments: argumentsObject,
      },
      undefined,
      {
        timeout,
      }
    );

    if (result?.isError) {
      throw providerError(result);
    }

    return result;
  } finally {
    await client.close();
  }
}

function retryLogger(skill, detail) {
  structuredLog("warn", "cmc_retry", {
    skill,
    attempt: detail.attempt,
    retries: detail.retries,
    delayMs: detail.delayMs,
    reason: detail.error?.message || "retryable provider error",
  });
}

async function findSkill(query, topK = 5) {
  const skill = "find_skill";
  const startedAt = Date.now();

  try {
    const result = await executeWithResilience(
      () => callToolOnce(
        "find_skill",
        {
          query,
          top_k: topK,
        },
        180000
      ),
      {
        onRetry: (detail) => retryLogger(skill, detail),
      }
    );

    recordCmcRequest(skill, Date.now() - startedAt, "success");
    return result;
  } catch (error) {
    recordCmcRequest(skill, Date.now() - startedAt, "error");
    recordCmcError(skill, error);
    structuredLog("error", "cmc_skill_failed", {
      skill,
      code: error.code || "UNKNOWN",
      message: error.message,
    });
    throw error;
  }
}

async function executeSkill(uniqueName, parameters = {}) {
  const skill = String(uniqueName || "unknown");
  const startedAt = Date.now();

  structuredLog("info", "cmc_skill_started", { skill });

  try {
    const result = await executeWithResilience(
      () => callToolOnce(
        "execute_skill",
        {
          unique_name: skill,
          parameters,
        },
        300000
      ),
      {
        onRetry: (detail) => retryLogger(skill, detail),
      }
    );

    recordCmcRequest(skill, Date.now() - startedAt, "success");
    structuredLog("info", "cmc_skill_completed", {
      skill,
      latencyMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    recordCmcRequest(skill, Date.now() - startedAt, "error");
    recordCmcError(skill, error);
    structuredLog("error", "cmc_skill_failed", {
      skill,
      code: error.code || "UNKNOWN",
      message: error.message,
    });
    throw error;
  }
}

module.exports = {
  createCmcClient,
  findSkill,
  executeSkill,
};
