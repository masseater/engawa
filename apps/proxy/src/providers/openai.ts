import type { ResolvedRoute } from "../types.js";
import { logError, logStream } from "../logger.js";
import { errorResponse } from "../errors.js";

const OPENAI_API_URL = "https://api.openai.com/v1";

// ─── Request Conversion (Anthropic → OpenAI) ────────────────────────

interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | null | Array<{ type: string; text?: string; [key: string]: unknown }>;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

function convertSystemMessage(
  system: string | Array<{ type: string; text: string }> | undefined,
): OpenAIMessage | null {
  if (!system) return null;
  if (typeof system === "string") {
    return { role: "developer", content: system };
  }
  const text = system
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return text ? { role: "developer", content: text } : null;
}

function extractTextContent(
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

function convertMessages(
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; [key: string]: unknown }>;
  }>,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      });
      continue;
    }

    const textBlocks: Array<{ type: string; [key: string]: unknown }> = [];
    const toolUseBlocks: Array<{ type: string; id?: string; name?: string; input?: unknown }> = [];
    const toolResultBlocks: Array<{
      type: string;
      tool_use_id?: string;
      content?: string | Array<{ type: string; text?: string }>;
      is_error?: boolean;
    }> = [];

    for (const block of msg.content) {
      if (block.type === "tool_use") {
        toolUseBlocks.push(block as (typeof toolUseBlocks)[number]);
      } else if (block.type === "tool_result") {
        toolResultBlocks.push(block as (typeof toolResultBlocks)[number]);
      } else {
        textBlocks.push(block);
      }
    }

    // tool_result blocks become separate tool messages
    for (const tr of toolResultBlocks) {
      let content: string;
      if (typeof tr.content === "string") {
        content = tr.content;
      } else if (Array.isArray(tr.content)) {
        content = tr.content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
      } else {
        content = "";
      }
      if (tr.is_error) {
        content = `[Error] ${content}`;
      }
      result.push({
        role: "tool",
        tool_call_id: tr.tool_use_id ?? "",
        content,
      });
    }

    // assistant message with tool_use becomes tool_calls
    if (msg.role === "assistant" && toolUseBlocks.length > 0) {
      const textContent = extractTextContent(textBlocks as Array<{ type: string; text?: string }>);
      result.push({
        role: "assistant",
        content: textContent || null,
        tool_calls: toolUseBlocks
          .filter((tu) => tu.name)
          .map((tu) => ({
            id: tu.id ?? "",
            type: "function" as const,
            function: {
              name: tu.name ?? "",
              arguments: JSON.stringify(tu.input ?? {}),
            },
          })),
      });
    } else if (textBlocks.length > 0 && toolUseBlocks.length === 0) {
      const textContent = extractTextContent(textBlocks as Array<{ type: string; text?: string }>);
      result.push({
        role: msg.role as "user" | "assistant",
        content: textContent,
      });
    }
  }

  return result;
}

function convertTools(
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>,
): OpenAITool[] | undefined {
  if (!tools?.length) return undefined;
  return tools
    .filter((t) => t.name)
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
}

function buildOpenAIRequest(
  body: Record<string, unknown>,
  route: ResolvedRoute,
): Record<string, unknown> {
  const messages: OpenAIMessage[] = [];

  const systemMsg = convertSystemMessage(
    body.system as string | Array<{ type: string; text: string }> | undefined,
  );
  if (systemMsg) messages.push(systemMsg);

  const converted = convertMessages(
    body.messages as Array<{
      role: string;
      content: string | Array<{ type: string; [key: string]: unknown }>;
    }>,
  );
  messages.push(...converted);

  const req: Record<string, unknown> = {
    model: route.targetModel,
    messages,
    max_tokens: body.max_tokens,
  };

  if (body.temperature !== undefined) req.temperature = body.temperature;
  if (body.top_p !== undefined) req.top_p = body.top_p;
  if (body.stop_sequences) req.stop = body.stop_sequences;

  const tools = convertTools(
    body.tools as
      | Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>
      | undefined,
  );
  if (tools) req.tools = tools;

  const effort = resolveEffort(body, route);
  if (effort) {
    req.reasoning = { effort };
  }

  if (body.stream) {
    req.stream = true;
    req.stream_options = { include_usage: true };
  }

  return req;
}

// ─── Effort Resolution ──────────────────────────────────────────────

function resolveEffort(body: Record<string, unknown>, route: ResolvedRoute): string | undefined {
  // 1. Config-level effort takes precedence if set
  if (route.config.effort) return route.config.effort;

  // 2. Claude Code sends output_config.effort directly
  const outputConfig = body.output_config as { effort?: string } | undefined;
  if (outputConfig?.effort) return outputConfig.effort;

  return undefined;
}

// ─── Responses API Request (for Codex OAuth) ────────────────────────

function buildResponsesApiRequest(
  body: Record<string, unknown>,
  route: ResolvedRoute,
): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];

  // System → instructions
  let instructions: string | undefined;
  const system = body.system as string | Array<{ type: string; text: string }> | undefined;
  if (typeof system === "string") {
    instructions = system;
  } else if (Array.isArray(system)) {
    instructions = system
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  // Convert Anthropic messages → Responses API input items
  const messages = body.messages as Array<{
    role: string;
    content: string | Array<{ type: string; [key: string]: unknown }>;
  }>;

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      input.push({
        type: "message",
        role: msg.role,
        content: [{ type: "input_text", text: msg.content }],
      });
      continue;
    }

    for (const block of msg.content) {
      if (block.type === "text") {
        input.push({
          type: "message",
          role: msg.role,
          content: [{ type: "input_text", text: block.text }],
        });
      } else if (block.type === "tool_use") {
        if (!block.name) continue;
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === "tool_result") {
        const resultContent =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? (block.content as Array<{ type: string; text?: string }>)
                  .filter((b) => b.type === "text")
                  .map((b) => b.text ?? "")
                  .join("")
              : "";
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: resultContent,
        });
      }
    }
  }

  const req: Record<string, unknown> = {
    model: route.targetModel,
    input,
    store: false,
    stream: true, // WHAM backend requires stream: true
  };

  req.instructions = instructions ?? "";
  // WHAM backend does not support temperature, top_p, or max_output_tokens

  // Convert tools
  const tools = body.tools as
    | Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>
    | undefined;
  if (tools?.length) {
    req.tools = tools
      .filter((t) => t.name)
      .map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      }));
  }

  const effort = resolveEffort(body, route);
  if (effort) {
    req.reasoning = { effort };
  }

  return req;
}

// ─── Responses API → Anthropic conversion ────────────────────────────

function convertResponsesApiResponse(
  data: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const output = data.output as Array<Record<string, unknown>> | undefined;
  const content: Array<Record<string, unknown>> = [];

  if (output) {
    for (const item of output) {
      if (item.type === "message") {
        const msgContent = item.content as Array<{ type: string; text?: string }> | undefined;
        if (msgContent) {
          for (const block of msgContent) {
            if (block.type === "output_text" && block.text) {
              content.push({ type: "text", text: block.text });
            }
          }
        }
      } else if (item.type === "function_call") {
        const input = JSON.parse(item.arguments as string);
        content.push({
          type: "tool_use",
          id: item.call_id,
          name: item.name,
          input,
        });
      }
    }
  }

  const status = data.status as string | undefined;
  let stopReason = "end_turn";
  if (status === "incomplete") stopReason = "max_tokens";

  // Check if there are tool uses
  if (content.some((c) => c.type === "tool_use")) {
    stopReason = "tool_use";
  }

  const usage = data.usage as Record<string, number> | undefined;

  return {
    id: generateId(),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    },
  };
}

// ─── Responses API Streaming → Anthropic SSE ─────────────────────────

function processResponsesStreamChunk(chunk: Record<string, unknown>, state: StreamState): string[] {
  const events: string[] = [];
  const type = chunk.type as string;

  if (!state.started) {
    state.started = true;
    events.push(
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: state.messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: state.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    );
  }

  if (type === "response.output_text.delta") {
    const delta = chunk.delta as string | undefined;
    if (delta) {
      if (!state.currentTextBlockOpen) {
        state.currentTextBlockOpen = true;
        events.push(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: state.contentIndex,
            content_block: { type: "text", text: "" },
          }),
        );
      }
      events.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: state.contentIndex,
          delta: { type: "text_delta", text: delta },
        }),
      );
    }
  } else if (type === "response.output_text.done") {
    if (state.currentTextBlockOpen) {
      state.currentTextBlockOpen = false;
      events.push(
        sseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.contentIndex,
        }),
      );
      state.contentIndex++;
    }
  } else if (type === "response.function_call_arguments.delta") {
    const delta = chunk.delta as string | undefined;
    const callId = chunk.call_id as string | undefined;
    const itemId = chunk.item_id as string | undefined;
    const key = itemId ?? callId ?? "unknown";

    if (!state.toolCalls.has(0) || state.toolCalls.get(0)?.id !== key) {
      // New tool call
      const tcIndex = state.toolCalls.size;
      state.toolCalls.set(tcIndex, {
        id: key,
        name: (chunk.name as string) ?? "",
        arguments: delta ?? "",
      });
      state.openToolBlocks.add(tcIndex);
      events.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: state.contentIndex + tcIndex,
          content_block: {
            type: "tool_use",
            id: callId ?? key,
            name: (chunk.name as string) ?? "",
            input: {},
          },
        }),
      );
    }
    if (delta) {
      const tcIndex = state.toolCalls.size - 1;
      events.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: state.contentIndex + tcIndex,
          delta: { type: "input_json_delta", partial_json: delta },
        }),
      );
    }
  } else if (type === "response.function_call_arguments.done") {
    for (const tcIndex of state.openToolBlocks) {
      events.push(
        sseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.contentIndex + tcIndex,
        }),
      );
    }
    state.openToolBlocks.clear();
  } else if (type === "response.completed") {
    const response = chunk.response as Record<string, unknown> | undefined;
    const usage = response?.usage as Record<string, number> | undefined;
    if (usage) {
      state.inputTokens = usage.input_tokens ?? 0;
      state.outputTokens = usage.output_tokens ?? 0;
    }

    const output = response?.output as Array<Record<string, unknown>> | undefined;
    const hasToolUse = output?.some((o) => o.type === "function_call") ?? false;

    events.push(
      sseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: hasToolUse ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: state.outputTokens },
      }),
    );
    events.push(sseEvent("message_stop", { type: "message_stop" }));
    state.stopped = true;
  }

  return events;
}

// ─── Response Conversion (OpenAI Chat Completions → Anthropic) ───────

function generateId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function convertFinishReason(reason: string | null): string {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop") return "end_turn";
  if (reason === "content_filter") return "end_turn";
  return "end_turn";
}

function convertNonStreamingResponse(
  data: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
  if (!choice) {
    return {
      id: generateId(),
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const message = choice.message as Record<string, unknown>;
  const content: Array<Record<string, unknown>> = [];

  if (message.content) {
    content.push({ type: "text", text: message.content as string });
  }

  const toolCalls = message.tool_calls as
    | Array<{
        id: string;
        function: { name: string; arguments: string };
      }>
    | undefined;

  if (toolCalls) {
    for (const tc of toolCalls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
  }

  const usage = data.usage as Record<string, number> | undefined;

  return {
    id: generateId(),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: convertFinishReason(choice.finish_reason as string | null),
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  };
}

// ─── Streaming Conversion (OpenAI SSE → Anthropic SSE) ──────────────

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface StreamState {
  messageId: string;
  model: string;
  started: boolean;
  contentIndex: number;
  currentTextBlockOpen: boolean;
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  openToolBlocks: Set<number>;
  inputTokens: number;
  outputTokens: number;
  stopped: boolean;
}

function createStreamState(model: string): StreamState {
  return {
    messageId: generateId(),
    model,
    started: false,
    contentIndex: 0,
    currentTextBlockOpen: false,
    toolCalls: new Map(),
    openToolBlocks: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    stopped: false,
  };
}

function processStreamChunk(chunk: Record<string, unknown>, state: StreamState): string[] {
  const events: string[] = [];

  // Emit message_start on first chunk
  if (!state.started) {
    state.started = true;
    events.push(
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: state.messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: state.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    );
  }

  const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
  if (!choices?.length) {
    // usage-only chunk
    const usage = chunk.usage as Record<string, number> | undefined;
    if (usage) {
      state.inputTokens = usage.prompt_tokens ?? 0;
      state.outputTokens = usage.completion_tokens ?? 0;
    }
    return events;
  }

  const choice = choices[0]!;
  const delta = choice.delta as Record<string, unknown> | undefined;
  if (!delta) return events;

  // Text content delta
  const contentDelta = delta.content as string | undefined;
  if (contentDelta) {
    if (!state.currentTextBlockOpen) {
      state.currentTextBlockOpen = true;
      events.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: state.contentIndex,
          content_block: { type: "text", text: "" },
        }),
      );
    }
    events.push(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: state.contentIndex,
        delta: { type: "text_delta", text: contentDelta },
      }),
    );
  }

  // Tool calls delta
  const toolCallsDeltas = delta.tool_calls as
    | Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>
    | undefined;

  if (toolCallsDeltas) {
    // Close text block if open
    if (state.currentTextBlockOpen) {
      state.currentTextBlockOpen = false;
      events.push(
        sseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.contentIndex,
        }),
      );
      state.contentIndex++;
    }

    for (const tcd of toolCallsDeltas) {
      const tcIndex = tcd.index;

      if (!state.toolCalls.has(tcIndex)) {
        // New tool call
        state.toolCalls.set(tcIndex, {
          id: tcd.id ?? "",
          name: tcd.function?.name ?? "",
          arguments: tcd.function?.arguments ?? "",
        });
        state.openToolBlocks.add(tcIndex);
        events.push(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: state.contentIndex + tcIndex,
            content_block: {
              type: "tool_use",
              id: tcd.id ?? "",
              name: tcd.function?.name ?? "",
              input: {},
            },
          }),
        );
        if (tcd.function?.arguments) {
          events.push(
            sseEvent("content_block_delta", {
              type: "content_block_delta",
              index: state.contentIndex + tcIndex,
              delta: {
                type: "input_json_delta",
                partial_json: tcd.function.arguments,
              },
            }),
          );
        }
      } else {
        // Continue existing tool call
        const tc = state.toolCalls.get(tcIndex)!;
        if (tcd.function?.arguments) {
          tc.arguments += tcd.function.arguments;
          events.push(
            sseEvent("content_block_delta", {
              type: "content_block_delta",
              index: state.contentIndex + tcIndex,
              delta: {
                type: "input_json_delta",
                partial_json: tcd.function.arguments,
              },
            }),
          );
        }
      }
    }
  }

  // Finish reason
  const finishReason = choice.finish_reason as string | null;
  if (finishReason) {
    // Close text block if still open
    if (state.currentTextBlockOpen) {
      state.currentTextBlockOpen = false;
      events.push(
        sseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.contentIndex,
        }),
      );
      state.contentIndex++;
    }

    // Close any open tool blocks
    for (const tcIndex of state.openToolBlocks) {
      events.push(
        sseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.contentIndex + tcIndex,
        }),
      );
    }
    state.openToolBlocks.clear();

    const usage = chunk.usage as Record<string, number> | undefined;
    if (usage) {
      state.inputTokens = usage.prompt_tokens ?? 0;
      state.outputTokens = usage.completion_tokens ?? 0;
    }

    events.push(
      sseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: convertFinishReason(finishReason),
          stop_sequence: null,
        },
        usage: { output_tokens: state.outputTokens },
      }),
    );
  }

  return events;
}

// ─── Auth ────────────────────────────────────────────────────────────

interface AuthResult {
  headers: Record<string, string>;
  source: "api-key" | "codex-oauth";
}

interface CodexAuthFile {
  OPENAI_API_KEY: string | null;
  tokens?: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id?: string;
  };
  last_refresh?: string;
}

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

function getCodexHomePath(): string {
  return process.env.CODEX_HOME || `${process.env.HOME}/.codex`;
}

async function refreshCodexToken(refreshToken: string): Promise<CodexAuthFile["tokens"] | null> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    logError(`Codex token refresh failed (${res.status})`, await res.text());
    return null;
  }
  const data = (await res.json()) as {
    id_token?: string;
    access_token: string;
    refresh_token?: string;
  };

  // Update auth.json
  const authPath = `${getCodexHomePath()}/auth.json`;
  const file = Bun.file(authPath);
  const existing = (await file.json()) as CodexAuthFile;
  const newTokens = {
    id_token: data.id_token ?? existing.tokens?.id_token ?? "",
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    account_id: existing.tokens?.account_id,
  };
  existing.tokens = newTokens;
  existing.last_refresh = new Date().toISOString();
  await Bun.write(authPath, JSON.stringify(existing, null, 2));

  return newTokens;
}

function isTokenExpired(accessToken: string): boolean {
  const payload = JSON.parse(atob(accessToken.split(".")[1]!));
  // 30 second safety margin
  return payload.exp * 1000 < Date.now() + 30_000;
}

async function loadCodexAuth(): Promise<AuthResult | null> {
  const codexHome = getCodexHomePath();
  const file = Bun.file(`${codexHome}/auth.json`);
  if (!(await file.exists())) return null;

  const auth = (await file.json()) as CodexAuthFile;

  // API key in auth.json
  if (auth.OPENAI_API_KEY) {
    return {
      headers: { authorization: `Bearer ${auth.OPENAI_API_KEY}` },
      source: "api-key",
    };
  }

  if (!auth.tokens?.access_token) return null;

  let tokens = auth.tokens;

  // Refresh if expired
  if (isTokenExpired(tokens.access_token)) {
    if (!tokens.refresh_token) return null;
    const refreshed = await refreshCodexToken(tokens.refresh_token);
    if (!refreshed) return null;
    tokens = refreshed;
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${tokens.access_token}`,
  };
  if (tokens.account_id) {
    headers["chatgpt-account-id"] = tokens.account_id;
  }

  return { headers, source: "codex-oauth" };
}

// ─── Main Handler ────────────────────────────────────────────────────

async function getAuth(route: ResolvedRoute): Promise<AuthResult | null> {
  // 1. Explicit apiKey in route config
  if (route.config.apiKey) {
    const key = route.config.apiKey.startsWith("sk-")
      ? route.config.apiKey
      : process.env[route.config.apiKey];
    if (key) return { headers: { authorization: `Bearer ${key}` }, source: "api-key" };
  }
  // 2. OPENAI_API_KEY env var
  if (process.env.OPENAI_API_KEY) {
    return {
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      source: "api-key",
    };
  }
  // 3. Local Codex session (~/.codex/auth.json) — always re-read (token may be refreshed)
  return loadCodexAuth();
}

function getBaseUrl(auth: AuthResult): string {
  if (auth.source === "codex-oauth") {
    return "https://chatgpt.com/backend-api/codex";
  }
  return OPENAI_API_URL;
}

async function collectResponsesStream(
  body: ReadableStream<Uint8Array>,
): Promise<Record<string, unknown> | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }

  // Parse SSE events and find response.completed
  for (const block of buffer.split("\n")) {
    const trimmed = block.trim();
    if (!trimmed.startsWith("data: ")) continue;
    const dataStr = trimmed.slice(6);
    if (dataStr === "[DONE]") continue;
    const chunk = JSON.parse(dataStr) as Record<string, unknown>;
    if (chunk.type === "response.completed") {
      return chunk.response as Record<string, unknown>;
    }
  }
  return null;
}

function createSSEStream(
  responseBody: ReadableStream<Uint8Array>,
  state: StreamState,
  chunkProcessor: (chunk: Record<string, unknown>, state: StreamState) => string[],
): ReadableStream<Uint8Array> {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (!state.stopped) {
            controller.enqueue(
              new TextEncoder().encode(sseEvent("message_stop", { type: "message_stop" })),
            );
          }
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;
          if (!trimmed.startsWith("data: ")) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === "[DONE]") {
            if (!state.stopped) {
              controller.enqueue(
                new TextEncoder().encode(sseEvent("message_stop", { type: "message_stop" })),
              );
            }
            controller.close();
            return;
          }

          const chunk = JSON.parse(dataStr) as Record<string, unknown>;
          const events = chunkProcessor(chunk, state);
          for (const event of events) {
            controller.enqueue(new TextEncoder().encode(event));
          }
        }
      }
    },
  });
}

export async function handleOpenAIRequest(
  _request: Request,
  body: Record<string, unknown>,
  route: ResolvedRoute,
): Promise<Response> {
  const auth = await getAuth(route);
  if (!auth) {
    return errorResponse(
      401,
      "OpenAI auth not configured. Set OPENAI_API_KEY, configure apiKey in route, or login to Codex CLI.",
    );
  }

  const baseUrl = getBaseUrl(auth);
  const isResponsesApi = auth.source === "codex-oauth";
  const reqBody = isResponsesApi
    ? buildResponsesApiRequest(body, route)
    : buildOpenAIRequest(body, route);
  const endpoint = isResponsesApi ? `${baseUrl}/responses` : `${baseUrl}/chat/completions`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...auth.headers,
    },
    body: JSON.stringify(reqBody),
  });

  if (!response.ok) {
    const errorData = await response.text();
    logError(`OpenAI API error (${response.status})`, errorData);
    const status = response.status === 401 ? 401 : response.status === 429 ? 429 : 500;
    return errorResponse(status, `OpenAI API error: ${errorData}`);
  }

  if (!response.body) {
    return errorResponse(502, "No response body from OpenAI API");
  }

  // Non-streaming: for Chat Completions, parse JSON directly.
  // For Responses API (WHAM), stream is always true, so collect the stream.
  if (!body.stream) {
    if (!isResponsesApi) {
      const data = (await response.json()) as Record<string, unknown>;
      return Response.json(convertNonStreamingResponse(data, route.targetModel));
    }
    // Responses API: collect stream and find response.completed event
    const completedData = await collectResponsesStream(response.body);
    if (!completedData) {
      return errorResponse(502, "No completed response from Responses API stream");
    }
    return Response.json(convertResponsesApiResponse(completedData, route.targetModel));
  }

  // Streaming
  logStream(route.targetModel, "converting stream");

  const state = createStreamState(route.targetModel);
  const chunkProcessor = isResponsesApi ? processResponsesStreamChunk : processStreamChunk;
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
  // OpenAI doesn't have a direct count_tokens endpoint.
  // Return an estimate or error.
  return errorResponse(
    400,
    "Token counting is not supported for OpenAI models. Use Anthropic models for accurate token counting.",
  );
}
