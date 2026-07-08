require("dotenv").config();

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");

const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");


// CREATE CMC CLIENT

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


// FIND SKILL

async function findSkill(query, topK = 5) {
  const client = await createCmcClient();

  try {
    const result = await client.callTool(
      {
        name: "find_skill",
        arguments: {
          query,
          top_k: topK,
        },
      },
      undefined,
      {
        timeout: 180000,
      }
    );

    return result;

  } finally {

    await client.close();

  }
}


// EXECUTE SKILL

async function executeSkill(uniqueName, parameters = {}) {
  const client = await createCmcClient();

  try {

    console.log(`Running CMC Skill: ${uniqueName}`);

    const result = await client.callTool(
      {
        name: "execute_skill",
        arguments: {
          unique_name: uniqueName,
          parameters,
        },
      },
      undefined,
      {
        timeout: 300000,
      }
    );

    console.log(`CMC Skill completed: ${uniqueName}`);

    return result;

  } finally {

    await client.close();

  }
}


// EXPORTS

module.exports = {
  createCmcClient,
  findSkill,
  executeSkill,
};