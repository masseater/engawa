import type { ResolvedRoute } from "../types.js";
import { logError, logStream, logDebug, logInfo } from "../logger.js";
import { errorResponse, authError, providerError } from "../errors.js";
import { resolveAuth, getBaseUrl } from "../infra/auth.js";
import {
  buildChatCompletionsRequest,
  buildResponsesApiRequest,
  convertChatCompletionsResponse,
  convertResponsesApiResponse,
} from "../domain/convert.js";
import {
  createStreamState,
  processChatCompletionsChunk,
  processResponsesApiChunk,
  createSSEStream,
  collectResponsesStream,
} from "../domain/stream.js";


export async function handleOpenAIRequest(
  _request: Request,
  body: Record<string, unknown>,
  route: ResolvedRoute,
): Promise<Response> {
  const auth = await resolveAuth(route.config.apiKey);
  if (!auth) {
    return authError();
  }

  const baseUrl = getBaseUrl(auth);
  const isResponsesApi = auth.source === "codex-oauth";
  const reqBody = isResponsesApi
    ? buildResponsesApiRequest(body, route)
    : buildChatCompletionsRequest(body, route);
  const endpoint = isResponsesApi ? `${baseUrl}/responses` : `${baseUrl}/chat/completions`;


  logInfo(`OpenAI ${isResponsesApi ? "Responses" : "ChatCompletions"} → ${endpoint}`);
  logDebug("openai-request", reqBody);

  let response: globalThis.Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...auth.headers,
      },
      body: JSON.stringify(reqBody),
    });
  } catch (err) {
    logError("OpenAI fetch failed", err);
    return errorResponse(502, `Failed to connect to OpenAI API: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    const errorData = await response.text();
    logError(`OpenAI API error (${response.status})`, errorData);
    return providerError(response.status, errorData);
  }

  if (!response.body) {
    return errorResponse(502, "No response body from OpenAI API");
  }

  // Non-streaming
  if (!body.stream) {
    if (!isResponsesApi) {
      const data = (await response.json()) as Record<string, unknown>;
      logDebug("openai-response", data);
      return Response.json(convertChatCompletionsResponse(data, route.targetModel));
    }
    const completedData = await collectResponsesStream(response.body);
    if (!completedData) {
      logError("Responses API returned no completed response");
      return errorResponse(502, "No completed response from Responses API stream");
    }
    logDebug("openai-response", completedData);
    return Response.json(convertResponsesApiResponse(completedData, route.targetModel));
  }

  // Streaming
  logStream(route.targetModel, "converting stream");

  const state = createStreamState(route.targetModel);
  const chunkProcessor = isResponsesApi ? processResponsesApiChunk : processChatCompletionsChunk;
  const stream = createSSEStream(response.body, state, chunkProcessor);

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

export async function handleOpenAICountTokens(
  _request: Request,
  _body: Record<string, unknown>,
  _route: ResolvedRoute,
): Promise<Response> {
  return errorResponse(
    400,
    "Token counting is not supported for OpenAI models. Use Anthropic models for accurate token counting.",
  );
}
