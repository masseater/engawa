export const EFFORT_LEVELS = ["xhigh", "high", "medium", "low", "minimal", "none"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface RouteConfig {
  provider: "anthropic" | "openai";
  model?: string;
  apiKey?: string;
  effort?: EffortLevel;
}

export interface EngawaConfig {
  port?: number;
  routes: Record<string, RouteConfig>;
  verbose?: boolean;
}

export interface ResolvedRoute {
  pattern: string;
  config: RouteConfig;
  targetModel: string;
}

export interface ProviderHandler {
  handleRequest(
    request: Request,
    body: Record<string, unknown>,
    route: ResolvedRoute,
  ): Promise<Response>;
  handleCountTokens(
    request: Request,
    body: Record<string, unknown>,
    route: ResolvedRoute,
  ): Promise<Response>;
}
