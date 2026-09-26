"use strict";

const fs = require("fs");
const path = require("path");
const solc = require("solc");

const contractsDir = path.join(__dirname, "..", "contracts");
const names = ["MockPerpsIA.sol", "PerpsIAStakingV1.sol"];
const input = { language: "Solidity", sources: Object.fromEntries(names.map((name) => [name, { content: fs.readFileSync(path.join(contractsDir, name), "utf8") }])), settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((item) => item.severity === "error");
for (const item of output.errors || []) console.log(item.formattedMessage.trim());
if (errors.length) process.exitCode = 1;
if (process.argv.includes("--write") && !errors.length) {
  const outDir = path.join(__dirname, "..", "artifacts", "contracts");
  fs.mkdirSync(outDir, { recursive: true });
  for (const [source, contracts] of Object.entries(output.contracts || {})) for (const [name, artifact] of Object.entries(contracts)) fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ contractName: name, sourceName: source, abi: artifact.abi, bytecode: artifact.evm.bytecode.object }, null, 2));
}
if (!errors.length) console.log(`Compiled ${Object.values(output.contracts || {}).reduce((sum, group) => sum + Object.keys(group).length, 0)} Solidity artifacts with solc ${solc.version()}.`);
