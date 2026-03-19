import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { resolveRoute } from "./router.js";
import { logRequest, logInfo, logBody, setVerbose } from "./logger.js";
import { errorResponse, routeNotFoundError } from "./errors.js";
import { sanitizeBody } from "./sanitize.js";
import { handleAnthropicRequest, handleAnthropicCountTokens } from "./providers/anthropic.js";
import { handleOpenAIRequest, handleOpenAICountTokens } from "./providers/openai.js";
import type { EngawaConfig, ProviderHandler, ResolvedRoute } from "./types.js";

const providers: Record<string, ProviderHandler> = {
  anthropic: {
    handleRequest: handleAnthropicRequest,
    handleCountTokens: handleAnthropicCountTokens,
  },
  openai: { handleRequest: handleOpenAIRequest, handleCountTokens: handleOpenAICountTokens },
};

export { defineConfig } from "./config.js";
export type { EngawaConfig, RouteConfig } from "./types.js";

function createApp(config: EngawaConfig) {
  const app = new Hono();

  function resolveAndGuard(
    body: Record<string, unknown>,
    path: string,
  ): { route: ResolvedRoute } | { error: Response } {
    const modelId = body.model as string;
    if (!modelId) return { error: errorResponse(400, "Missing 'model' field in request body") };
    const route = resolveRoute(modelId, config);
    if (!route) return { error: routeNotFoundError(modelId) };
    logRequest("POST", path, modelId, route.config.provider, route.targetModel);
    return { route };
  }

  function dispatch(
    request: Request,
    body: Record<string, unknown>,
    route: ResolvedRoute,
    handler: "messages" | "count_tokens",
  ): Promise<Response> {
    const provider = providers[route.config.provider];
    if (!provider) {
      return Promise.resolve(errorResponse(400, `Unknown provider: ${route.config.provider}`));
    }
    return handler === "messages"
      ? provider.handleRequest(request, body, route)
      : provider.handleCountTokens(request, body, route);
  }

  app.post("/v1/messages", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = resolveAndGuard(body, "/v1/messages");
    if ("error" in result) return result.error;
    const cleaned = sanitizeBody(body);
    logBody("incoming", cleaned);
    return dispatch(c.req.raw, cleaned, result.route, "messages");
  });

  app.post("/v1/messages/count_tokens", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = resolveAndGuard(body, "/v1/messages/count_tokens");
    if ("error" in result) return result.error;
    return dispatch(c.req.raw, sanitizeBody(body), result.route, "count_tokens");
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  return app;
}

export async function startServer(overrideConfig?: EngawaConfig) {
  const config = overrideConfig ?? (await loadConfig());
  setVerbose(config.verbose ?? true);

  const app = createApp(config);
  const port = config.port ?? 3131;

  const routeEntries = Object.entries(config.routes);
  logInfo(`engawa proxy starting on port ${port}`);
  logInfo(`Routes:`);
  for (const [pattern, rc] of routeEntries) {
    logInfo(`  ${pattern} → ${rc.provider}${rc.model ? ` (${rc.model})` : ""}`);
  }

  const maxRetries = 10;
  let attempt = 0;

  return new Promise<{ port: number; stop: () => void }>((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        port,
      },
      (info) => {
        logInfo(`engawa proxy ready at http://localhost:${info.port}`);
        resolve({ port: info.port, stop: () => server.close() });
      },
    );
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        attempt++;
        if (attempt >= maxRetries) {
          reject(new Error(`All ports ${port}-${port + maxRetries} are in use.`));
          return;
        }
        const nextPort = port + attempt;
        logInfo(`Port ${port + attempt - 1} is in use, trying ${nextPort}...`);
        server.listen(nextPort);
      } else {
        reject(err);
      }
    });
  });
}
