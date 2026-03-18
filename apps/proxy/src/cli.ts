#!/usr/bin/env bun
import { startServer } from "./index.js";
import { loadConfig } from "./config.js";
import { logInfo, logError } from "./logger.js";

async function main() {
  const config = await loadConfig();
  const port = config.port ?? 3131;

  const server = await startServer(config);

  // Separate engawa flags from claude flags
  const args = process.argv.slice(2);

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
