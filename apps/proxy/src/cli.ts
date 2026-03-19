#!/usr/bin/env node
import { startServer } from "./index.js";
import { loadConfig, getConfigPath, fileExists } from "./config.js";
import { logInfo, logError, setLogFile } from "./logger.js";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

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

    if (await fileExists(filepath)) {
      logInfo(`  skip: ${name}.md (already exists)`);
      continue;
    }

    const desc = `${model} subagent via engawa proxy.`;
    await writeFile(filepath, agentMarkdown(name, model, desc));
    logInfo(`  created: ${name}.md → model: ${model}`);
  }

  logInfo("Done! Use subagent_type in Agent tool to invoke these models.");
}

function getLogPath(): string {
  const runtimeDir = process.env.ENGAWA_HOME
    ? process.env.ENGAWA_HOME
    : (process.env.XDG_RUNTIME_DIR ?? resolve(process.env.HOME ?? "~", ".local", "state"));
  return resolve(runtimeDir, "engawa", "proxy.log");
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "init") {
    logInfo(`Config: ${getConfigPath()}/config.ts`);
    logInfo("Generating agent definitions from engawa config...");
    await init();
    return;
  }

  if (args[0] === "logs") {
    const logPath = getLogPath();
    const follow = args.includes("-f") || args.includes("--follow");
    const tailArgs = follow ? ["-f", "-n", "100", logPath] : ["-n", "200", logPath];
    const tail = spawn("tail", tailArgs, { stdio: "inherit" });
    tail.on("close", (code) => process.exit(code ?? 0));
    return;
  }

  const config = await loadConfig();
  const noClaude = args.includes("--no-claude");
  const claudeArgs = args.filter((a) => a !== "--no-claude");

  // Setup logs go to console
  const server = await startServer(config);

  if (noClaude) {
    logInfo("Running in proxy-only mode (no Claude process)");
    process.on("SIGINT", () => {
      logInfo("Shutting down engawa proxy...");
      server.stop();
      process.exit(0);
    });
    return;
  }

  const customModels = Object.keys(config.routes)
    .filter((pattern) => !pattern.includes("*"))
    .filter((pattern) => config.routes[pattern]!.provider !== "anthropic");

  const customModelOption = customModels[0];

  logInfo(`Launching claude with ANTHROPIC_BASE_URL=http://localhost:${server.port}`);
  if (customModels.length > 0) {
    logInfo(`Available models via proxy: ${customModels.join(", ")}`);
    logInfo(`ANTHROPIC_CUSTOM_MODEL_OPTION=${customModelOption}`);
  }

  // Switch to file logging before Claude takes over the terminal
  const logPath = getLogPath();
  setLogFile(logPath);
  logInfo("--- session start ---");

  const claudeProc = spawn("claude", claudeArgs, {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${server.port}`,
      ...(customModelOption ? { ANTHROPIC_CUSTOM_MODEL_OPTION: customModelOption } : {}),
    },
    stdio: "inherit",
  });

  const exitCode = await new Promise<number>((resolve) => {
    claudeProc.on("close", (code) => resolve(code ?? 1));
  });

  // Back to console after Claude exits
  setLogFile(null);
  logInfo(`Claude exited with code ${exitCode}, shutting down proxy...`);
  server.stop();
  process.exit(exitCode);
}

main().catch((err) => {
  logError("Fatal error", err);
  process.exit(1);
});
