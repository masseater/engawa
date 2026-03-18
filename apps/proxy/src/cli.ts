#!/usr/bin/env bun
import { startServer } from "./index.js";
import { loadConfig, getConfigPath } from "./config.js";
import { logInfo, logError } from "./logger.js";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

function agentMarkdown(name: string, model: string, description: string): string {
  return `---
name: ${name}
model: ${model}
description: ${description}
---

You are a helpful assistant running as a subagent via engawa proxy. Complete the task given to you concisely and accurately.
`;
}

async function init() {
  const config = await loadConfig();
  const agentsDir = resolve(process.cwd(), ".claude", "agents");
  await mkdir(agentsDir, { recursive: true });

  const routes = Object.entries(config.routes).filter(
    ([pattern, rc]) => !pattern.includes("*") && rc.provider !== "anthropic",
  );

  if (routes.length === 0) {
    logInfo("No non-Anthropic routes found in config. Nothing to generate.");
    return;
  }

  for (const [pattern, rc] of routes) {
    const name = pattern.replace(/[^a-zA-Z0-9-]/g, "-");
    const model = rc.model ?? pattern;
    const filepath = resolve(agentsDir, `${name}.md`);
    const file = Bun.file(filepath);

    if (await file.exists()) {
      logInfo(`  skip: ${name}.md (already exists)`);
      continue;
    }

    const desc = `${model} subagent via engawa proxy.`;
    await Bun.write(filepath, agentMarkdown(name, model, desc));
    logInfo(`  created: ${name}.md → model: ${model}`);
  }

  logInfo("Done! Use subagent_type in Agent tool to invoke these models.");
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "init") {
    logInfo(`Config: ${getConfigPath()}/config.ts`);
    logInfo("Generating agent definitions from engawa config...");
    await init();
    return;
  }

  const config = await loadConfig();
  const port = config.port ?? 3131;

  const server = await startServer(config);

  // Check if --no-claude flag is present (proxy-only mode)
  const noClaude = args.includes("--no-claude");
  const claudeArgs = args.filter((a) => a !== "--no-claude");

  if (noClaude) {
    logInfo("Running in proxy-only mode (no Claude process)");
    // Keep running until interrupted
    process.on("SIGINT", () => {
      logInfo("Shutting down engawa proxy...");
      server.stop();
      process.exit(0);
    });
    return;
  }

  // Pick first non-anthropic route as ANTHROPIC_CUSTOM_MODEL_OPTION (only supports single model)
  const customModels = Object.keys(config.routes)
    .filter((pattern) => !pattern.includes("*"))
    .filter((pattern) => config.routes[pattern]!.provider !== "anthropic");

  const customModelOption = customModels[0];

  logInfo(`Launching claude with ANTHROPIC_BASE_URL=http://localhost:${port}`);
  if (customModels.length > 0) {
    logInfo(`Available models via proxy: ${customModels.join(", ")}`);
    logInfo(`/model picker: ${customModelOption}`);
  }

  const claudeProc = Bun.spawn(["claude", ...claudeArgs], {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${port}`,
      ...(customModelOption ? { ANTHROPIC_CUSTOM_MODEL_OPTION: customModelOption } : {}),
    },
    stdio: ["inherit", "inherit", "inherit"],
  });

  // When claude exits, stop the proxy
  const exitCode = await claudeProc.exited;
  logInfo(`Claude exited with code ${exitCode}, shutting down proxy...`);
  server.stop();
  process.exit(exitCode);
}

main().catch((err) => {
  logError("Fatal error", err);
  process.exit(1);
});
