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

function buildHeaders(request: Request, route: ResolvedRoute): Headers {
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
  return headers;
}

function sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
  if (!messages) return body;

  const cleaned = messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: (msg.content as Array<Record<string, unknown>>).filter(
        (block) => block.type !== "tool_use" || block.name,
      ),
    };
  });

  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  const cleanedTools = tools?.filter((t) => t.name);

  return { ...body, messages: cleaned, ...(tools ? { tools: cleanedTools } : {}) };
}

export async function handleAnthropicRequest(
  request: Request,
  body: Record<string, unknown>,
  route: ResolvedRoute,
): Promise<Response> {
  const url = new URL(request.url);
  const targetUrl = `${ANTHROPIC_API_URL}${url.pathname}`;
  const headers = buildHeaders(request, route);
  const outBody = sanitizeBody({ ...body, model: route.targetModel });

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
  const headers = buildHeaders(request, route);
  const outBody = sanitizeBody({ ...body, model: route.targetModel });

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
