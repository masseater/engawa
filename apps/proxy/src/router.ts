import { EFFORT_LEVELS } from "./types.js";
import type { EngawaConfig, RouteConfig, ResolvedRoute, EffortLevel } from "./types.js";

type RouteEntry = [pattern: string, config: RouteConfig];

function matchPattern(pattern: string, modelId: string): boolean {
  if (pattern === modelId) return true;
  if (pattern.endsWith("*")) {
    return modelId.startsWith(pattern.slice(0, -1));
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

// Pre-compiled route entries to avoid Object.entries() on every request
const routeCache = new WeakMap<Record<string, RouteConfig>, RouteEntry[]>();

function getRouteEntries(routes: Record<string, RouteConfig>): RouteEntry[] {
  let entries = routeCache.get(routes);
  if (!entries) {
    entries = Object.entries(routes);
    routeCache.set(routes, entries);
  }
  return entries;
}

function findMatch(
  entries: RouteEntry[],
  modelId: string,
): ResolvedRoute | null {
  for (const [pattern, routeConfig] of entries) {
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

export function resolveRoute(modelId: string, config: EngawaConfig): ResolvedRoute | null {
  const entries = getRouteEntries(config.routes);

  // Try exact match first
  const direct = findMatch(entries, modelId);
  if (direct) return direct;

  // Try stripping effort suffix: "o3-high" → route "o3" + effort "high"
  const parsed = parseEffortSuffix(modelId);
  if (parsed) {
    const match = findMatch(entries, parsed.baseModel);
    if (match) {
      return {
        ...match,
        config: { ...match.config, effort: match.config.effort ?? parsed.effort },
        targetModel: match.config.model ?? parsed.baseModel,
      };
    }
  }

  return null;
}
