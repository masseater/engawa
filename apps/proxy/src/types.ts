export interface RouteConfig {
  provider: "anthropic" | "openai";
  model?: string;
  apiKey?: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
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
