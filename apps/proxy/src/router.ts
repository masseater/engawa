import { EFFORT_LEVELS } from "./types.js";
import type { EngawaConfig, ResolvedRoute, EffortLevel } from "./types.js";

function matchPattern(pattern: string, modelId: string): boolean {
  if (pattern === modelId) return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return modelId.startsWith(prefix);
  }
  return false;
}

function parseEffortSuffix(modelId: string): { baseModel: string; effort: EffortLevel } | null {
  for (const suffix of EFFORT_LEVELS) {
    if (modelId.endsWith(`-${suffix}`)) {
      return {
        baseModel: modelId.slice(0, -(suffix.length + 1)),
        effort: suffix as EffortLevel,
      };
    }
  }
  return null;
}

export function resolveRoute(modelId: string, config: EngawaConfig): ResolvedRoute | null {
  // Try exact match first
  for (const [pattern, routeConfig] of Object.entries(config.routes)) {
    if (matchPattern(pattern, modelId)) {
      return {
        pattern,
        config: routeConfig,
        targetModel: routeConfig.model ?? modelId,
      };
    }
  }

  // Try stripping effort suffix: "o3-high" → route "o3" + effort "high"
  const parsed = parseEffortSuffix(modelId);
  if (parsed) {
    for (const [pattern, routeConfig] of Object.entries(config.routes)) {
      if (matchPattern(pattern, parsed.baseModel)) {
        return {
          pattern,
          config: { ...routeConfig, effort: routeConfig.effort ?? parsed.effort },
          targetModel: routeConfig.model ?? parsed.baseModel,
        };
      }
    }
  }

  return null;
}
