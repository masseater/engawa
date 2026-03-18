import type { ResolvedRoute } from "../types.js";
import { logError, logStream } from "../logger.js";
import { errorResponse } from "../errors.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com";

const FORWARDED_HEADERS = [
  "anthropic-beta",
  "anthropic-version",
  "x-api-key",
  "authorization",
  "content-type",
] as const;

export async function handleAnthropicRequest(
  request: Request,
  body: Record<string, unknown>,
  route: ResolvedRoute,
): Promise<Response> {
  const url = new URL(request.url);
  const targetUrl = `${ANTHROPIC_API_URL}${url.pathname}`;

  const headers = new Headers();
  for (const key of FORWARDED_HEADERS) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }

  if (route.config.apiKey) {
    const apiKey = route.config.apiKey.startsWith("sk-")
      ? route.config.apiKey
      : process.env[route.config.apiKey];
    if (apiKey) headers.set("x-api-key", apiKey);
  }

  const outBody = { ...body, model: route.targetModel };

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(outBody),
    });

    if (body.stream) {
      if (!response.body) {
        return errorResponse(502, "No response body from Anthropic API");
      }
      logStream(route.targetModel, "proxying stream");
      return new Response(response.body, {
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type") ?? "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    const data = await response.json();
    return Response.json(data, { status: response.status });
  } catch (error) {
    logError("Anthropic API request failed", error);
    return errorResponse(
      502,
      `Anthropic API request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handleAnthropicCountTokens(
  request: Request,
  body: Record<string, unknown>,
  route: ResolvedRoute,
): Promise<Response> {
  const targetUrl = `${ANTHROPIC_API_URL}/v1/messages/count_tokens`;

  const headers = new Headers();
  for (const key of FORWARDED_HEADERS) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }

  if (route.config.apiKey) {
    const apiKey = route.config.apiKey.startsWith("sk-")
      ? route.config.apiKey
      : process.env[route.config.apiKey];
    if (apiKey) headers.set("x-api-key", apiKey);
  }

  const outBody = { ...body, model: route.targetModel };

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(outBody),
    });
    const data = await response.json();
    return Response.json(data, { status: response.status });
  } catch (error) {
    logError("Anthropic count_tokens failed", error);
    return errorResponse(
      502,
      `Anthropic count_tokens failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
