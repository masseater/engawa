import type { EngawaConfig } from "./types.js";
import { resolve } from "node:path";

export type { EngawaConfig, RouteConfig } from "./types.js";

export function defineConfig(config: EngawaConfig): EngawaConfig {
  return config;
}

const CONFIG_FILENAMES = ["engawa.config.ts", "engawa.config.js"];

export async function loadConfig(cwd = process.cwd()): Promise<EngawaConfig> {
  for (const filename of CONFIG_FILENAMES) {
    const filepath = resolve(cwd, filename);
    const file = Bun.file(filepath);
    if (await file.exists()) {
      const mod = await import(filepath);
      const config: EngawaConfig = mod.default ?? mod;
      return {
        port: config.port ?? 3131,
        verbose: config.verbose ?? true,
        routes: config.routes,
      };
    }
  }

  return {
    port: 3131,
    verbose: true,
    routes: {
      "claude-*": { provider: "anthropic" },
    },
  };
}
