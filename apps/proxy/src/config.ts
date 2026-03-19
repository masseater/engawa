import type { EngawaConfig } from "./types.js";
import { resolve, parse } from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";
import { logInfo } from "./logger.js";

export type { EngawaConfig, RouteConfig } from "./types.js";

export function defineConfig(config: EngawaConfig): EngawaConfig {
  return config;
}

function getConfigDir(): string {
  if (process.env.ENGAWA_HOME) return process.env.ENGAWA_HOME;
  return process.env.XDG_CONFIG_HOME
    ? resolve(process.env.XDG_CONFIG_HOME, "engawa")
    : resolve(process.env.HOME ?? "~", ".config", "engawa");
}

export function getConfigPath(): string {
  return getConfigDir();
}

const DEFAULT_PORT = 3131;
const DEFAULT_VERBOSE = true;

const CONFIG_FILENAMES = ["config.ts", "config.js"];
const LOCAL_CONFIG_FILENAMES = ["engawa.config.ts", "engawa.config.js"];

export async function fileExists(filepath: string): Promise<boolean> {
  return access(filepath).then(
    () => true,
    () => false,
  );
}

async function loadConfigFile(filepath: string): Promise<EngawaConfig> {
  const mod = await import(filepath);
  const config: EngawaConfig = mod.default ?? mod;
  return {
    port: config.port ?? DEFAULT_PORT,
    verbose: config.verbose ?? DEFAULT_VERBOSE,
    routes: config.routes,
  };
}

async function tryLoad(dir: string): Promise<EngawaConfig | null> {
  for (const filename of CONFIG_FILENAMES) {
    const filepath = resolve(dir, filename);
    if (!(await fileExists(filepath))) continue;
    return loadConfigFile(filepath);
  }
  return null;
}

const DEFAULT_CONFIG_CONTENT = `// engawa config — https://github.com/anthropics/engawa
export default {
  port: 3131,
  routes: {
    "claude-*": { provider: "anthropic" },
    "gpt-5.4": { provider: "openai", model: "gpt-5.4" },
  },
};
`;

async function createDefaultConfig(): Promise<void> {
  const dir = getConfigDir();
  const filepath = resolve(dir, "config.ts");
  await mkdir(dir, { recursive: true });
  await writeFile(filepath, DEFAULT_CONFIG_CONTENT);
  logInfo(`Created default config: ${filepath}`);
}

async function tryLoadLocal(startDir: string): Promise<EngawaConfig | null> {
  let dir = startDir;
  const { root } = parse(dir);

  while (dir !== root) {
    for (const filename of LOCAL_CONFIG_FILENAMES) {
      const filepath = resolve(dir, filename);
      if (!(await fileExists(filepath))) continue;
      logInfo(`Loading config: ${filepath}`);
      return loadConfigFile(filepath);
    }
    dir = resolve(dir, "..");
  }
  return null;
}

export async function loadConfig(): Promise<EngawaConfig> {
  // 1. CWD: ./engawa.config.ts
  const localConfig = await tryLoadLocal(process.cwd());
  if (localConfig) return localConfig;

  // 2. XDG: ~/.config/engawa/config.ts
  const xdgConfig = await tryLoad(getConfigDir());
  if (xdgConfig) return xdgConfig;

  await createDefaultConfig();

  return {
    port: DEFAULT_PORT,
    verbose: DEFAULT_VERBOSE,
    routes: {
      "claude-*": { provider: "anthropic" },
      "gpt-5.4": { provider: "openai", model: "gpt-5.4" },
    },
  };
}
