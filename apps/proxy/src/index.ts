import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { resolveRoute } from "./router.js";
import { logRequest, logInfo, logBody, setVerbose } from "./logger.js";
import { errorResponse } from "./errors.js";
import { handleAnthropicRequest, handleAnthropicCountTokens } from "./providers/anthropic.js";
import { handleOpenAIRequest, handleOpenAICountTokens } from "./providers/openai.js";
import type { EngawaConfig, ResolvedRoute } from "./types.js";

export { defineConfig } from "./config.js";
export type { EngawaConfig, RouteConfig } from "./types.js";

const app = new Hono();

let config: EngawaConfig;

async function dispatch(
  request: Request,
  body: Record<string, unknown>,
  route: ResolvedRoute,
  handler: "messages" | "count_tokens",
): Promise<Response> {
  if (handler === "messages") {
    if (route.config.provider === "anthropic") {
      return handleAnthropicRequest(request, body, route);
    }
    return handleOpenAIRequest(request, body, route);
  }
  // count_tokens
  if (route.config.provider === "anthropic") {
    return handleAnthropicCountTokens(request, body, route);
  }
  return handleOpenAICountTokens(request, body, route);
}

app.post("/v1/messages", async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  const modelId = body.model as string;

  if (!modelId) {
    return errorResponse(400, "Missing 'model' field in request body");
  }

  const route = resolveRoute(modelId, config);
  if (!route) {
    return errorResponse(400, `No route configured for model: ${modelId}`);
  }

  logRequest("POST", "/v1/messages", modelId, route.config.provider, route.targetModel);
  logBody("incoming", body);
  return dispatch(c.req.raw, body, route, "messages");
});

app.post("/v1/messages/count_tokens", async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  const modelId = body.model as string;

  if (!modelId) {
    return errorResponse(400, "Missing 'model' field in request body");
  }

  const route = resolveRoute(modelId, config);
  if (!route) {
    return errorResponse(400, `No route configured for model: ${modelId}`);
  }

  logRequest(
    "POST",
    "/v1/messages/count_tokens",
    modelId,
    route.config.provider,
    route.targetModel,
  );
  return dispatch(c.req.raw, body, route, "count_tokens");
});

app.get("/health", (c) => c.json({ status: "ok" }));

export async function startServer(overrideConfig?: EngawaConfig) {
  config = overrideConfig ?? (await loadConfig());
  setVerbose(config.verbose ?? true);

  const port = config.port ?? 3131;

  const routeEntries = Object.entries(config.routes);
  logInfo(`engawa proxy starting on port ${port}`);
  logInfo(`Routes:`);
  for (const [pattern, rc] of routeEntries) {
    logInfo(`  ${pattern} → ${rc.provider}${rc.model ? ` (${rc.model})` : ""}`);
  }

  const server = Bun.serve({
    port,
    fetch: app.fetch,
  });

  logInfo(`engawa proxy ready at http://localhost:${port}`);
  return server;
}

// Direct execution
if (import.meta.main) {
  startServer();
}
