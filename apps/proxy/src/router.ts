import type { EngawaConfig, ResolvedRoute } from "./types.js";

function matchPattern(pattern: string, modelId: string): boolean {
  if (pattern === modelId) return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return modelId.startsWith(prefix);
  }
  return false;
}

export function resolveRoute(modelId: string, config: EngawaConfig): ResolvedRoute | null {
  for (const [pattern, routeConfig] of Object.entries(config.routes)) {
    if (matchPattern(pattern, modelId)) {
      return {
        pattern,
        config: routeConfig,
        targetModel: routeConfig.model ?? modelId,
      };
    }
  }
  return null;
}
