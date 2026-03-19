import type { ResolvedRoute } from "../types.js";

// ─── Types ──────────────────────────────────────────────────────────

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

// ─── Helpers ────────────────────────────────────────────────────────

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

export function convertFinishReason(reason: string | null): string {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop") return "end_turn";
  if (reason === "content_filter") return "end_turn";
  return "end_turn";
}

export function generateId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Anthropic → OpenAI Chat Completions ────────────────────────────

function convertMessages(
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; [key: string]: unknown }>;
  }>,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role as "user" | "assistant", content: msg.content });
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
      if (tr.is_error) content = `[Error] ${content}`;
      result.push({ role: "tool", tool_call_id: tr.tool_use_id ?? "", content });
    }

    if (msg.role === "assistant" && toolUseBlocks.length > 0) {
      const textContent = extractTextContent(textBlocks as Array<{ type: string; text?: string }>);
      result.push({
        role: "assistant",
        content: textContent || null,
        tool_calls: toolUseBlocks.map((tu) => ({
          id: tu.id ?? "",
          type: "function" as const,
          function: { name: tu.name ?? "", arguments: JSON.stringify(tu.input ?? {}) },
        })),
      });
    } else if (textBlocks.length > 0 && toolUseBlocks.length === 0) {
      const textContent = extractTextContent(textBlocks as Array<{ type: string; text?: string }>);
      result.push({ role: msg.role as "user" | "assistant", content: textContent });
    }
  }

  return result;
}

function convertTools(
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>,
): OpenAITool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

export function buildChatCompletionsRequest(
  body: Record<string, unknown>,
  route: ResolvedRoute,
): Record<string, unknown> {
  const messages: OpenAIMessage[] = [];

  const systemMsg = convertSystemMessage(
    body.system as string | Array<{ type: string; text: string }> | undefined,
  );
  if (systemMsg) messages.push(systemMsg);
  messages.push(
    ...convertMessages(
      body.messages as Array<{
        role: string;
        content: string | Array<{ type: string; [key: string]: unknown }>;
      }>,
    ),
  );

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
  if (effort) req.reasoning = { effort };

  if (body.stream) {
    req.stream = true;
    req.stream_options = { include_usage: true };
  }

  return req;
}

// ─── Anthropic → OpenAI Responses API ───────────────────────────────

export function buildResponsesApiRequest(
  body: Record<string, unknown>,
  route: ResolvedRoute,
): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];

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

  const messages = body.messages as Array<{
    role: string;
    content: string | Array<{ type: string; [key: string]: unknown }>;
  }>;

  for (const msg of messages) {
    const textType = msg.role === "assistant" ? "output_text" : "input_text";

    if (typeof msg.content === "string") {
      input.push({
        type: "message",
        role: msg.role,
        content: [{ type: textType, text: msg.content }],
      });
      continue;
    }

    for (const block of msg.content) {
      if (block.type === "text") {
        input.push({
          type: "message",
          role: msg.role,
          content: [{ type: textType, text: block.text }],
        });
      } else if (block.type === "tool_use") {
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
    stream: true,
    instructions: instructions ?? "",
  };

  const tools = body.tools as
    | Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>
    | undefined;
  if (tools?.length) {
    req.tools = tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }));
  }

  const effort = resolveEffort(body, route);
  if (effort) req.reasoning = { effort };

  return req;
}

// ─── OpenAI → Anthropic Response ────────────────────────────────────

export function convertChatCompletionsResponse(
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
    | Array<{ id: string; function: { name: string; arguments: string } }>
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

export function convertResponsesApiResponse(
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
        content.push({
          type: "tool_use",
          id: item.call_id,
          name: item.name,
          input: JSON.parse(item.arguments as string),
        });
      }
    }
  }

  const status = data.status as string | undefined;
  let stopReason = "end_turn";
  if (status === "incomplete") stopReason = "max_tokens";
  if (content.some((c) => c.type === "tool_use")) stopReason = "tool_use";

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

// ─── Effort Resolution ──────────────────────────────────────────────

export function resolveEffort(
  body: Record<string, unknown>,
  route: ResolvedRoute,
): string | undefined {
  if (route.config.effort) return route.config.effort;
  const outputConfig = body.output_config as { effort?: string } | undefined;
  if (outputConfig?.effort) return outputConfig.effort;
  return undefined;
}
