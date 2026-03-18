import type { EngawaConfig } from "./types.js";
import { resolve } from "node:path";

export type { EngawaConfig, RouteConfig } from "./types.js";

export function defineConfig(config: EngawaConfig): EngawaConfig {
  return config;
}

function getConfigDir(): string {
  return process.env.XDG_CONFIG_HOME
    ? resolve(process.env.XDG_CONFIG_HOME, "engawa")
    : resolve(process.env.HOME ?? "~", ".config", "engawa");
}

export function getConfigPath(): string {
  return getConfigDir();
}

const CONFIG_FILENAMES = ["config.ts", "config.js"];

async function tryLoad(dir: string): Promise<EngawaConfig | null> {
  for (const filename of CONFIG_FILENAMES) {
    const filepath = resolve(dir, filename);
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
  return null;
}

export async function loadConfig(): Promise<EngawaConfig> {
  // XDG: ~/.config/engawa/config.ts
  const xdgConfig = await tryLoad(getConfigDir());
  if (xdgConfig) return xdgConfig;

  return {
    port: 3131,
    verbose: true,
    routes: {
      "claude-*": { provider: "anthropic" },
    },
  };
}
