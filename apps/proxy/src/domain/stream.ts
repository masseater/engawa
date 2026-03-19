import { convertFinishReason, generateId } from "./convert.js";

// ─── SSE Helpers ────────────────────────────────────────────────────

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ─── Stream State ───────────────────────────────────────────────────

export interface StreamState {
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

export function createStreamState(model: string): StreamState {
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

function emitMessageStart(state: StreamState, events: string[]): void {
  if (state.started) return;
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

// ─── Chat Completions Chunk Processor ───────────────────────────────

export function processChatCompletionsChunk(
  chunk: Record<string, unknown>,
  state: StreamState,
): string[] {
  const events: string[] = [];
  emitMessageStart(state, events);

  const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
  if (!choices?.length) {
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

  const toolCallsDeltas = delta.tool_calls as
    | Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
    | undefined;

  if (toolCallsDeltas) {
    if (state.currentTextBlockOpen) {
      state.currentTextBlockOpen = false;
      events.push(
        sseEvent("content_block_stop", { type: "content_block_stop", index: state.contentIndex }),
      );
      state.contentIndex++;
    }

    for (const tcd of toolCallsDeltas) {
      const tcIndex = tcd.index;
      if (!state.toolCalls.has(tcIndex)) {
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
              delta: { type: "input_json_delta", partial_json: tcd.function.arguments },
            }),
          );
        }
      } else {
        const tc = state.toolCalls.get(tcIndex)!;
        if (tcd.function?.arguments) {
          tc.arguments += tcd.function.arguments;
          events.push(
            sseEvent("content_block_delta", {
              type: "content_block_delta",
              index: state.contentIndex + tcIndex,
              delta: { type: "input_json_delta", partial_json: tcd.function.arguments },
            }),
          );
        }
      }
    }
  }

  const finishReason = choice.finish_reason as string | null;
  if (finishReason) {
    if (state.currentTextBlockOpen) {
      state.currentTextBlockOpen = false;
      events.push(
        sseEvent("content_block_stop", { type: "content_block_stop", index: state.contentIndex }),
      );
      state.contentIndex++;
    }
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
        delta: { stop_reason: convertFinishReason(finishReason), stop_sequence: null },
        usage: { output_tokens: state.outputTokens },
      }),
    );
  }

  return events;
}

// ─── Responses API Chunk Processor ──────────────────────────────────

export function processResponsesApiChunk(
  chunk: Record<string, unknown>,
  state: StreamState,
): string[] {
  const events: string[] = [];
  emitMessageStart(state, events);
  const type = chunk.type as string;

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
        sseEvent("content_block_stop", { type: "content_block_stop", index: state.contentIndex }),
      );
      state.contentIndex++;
    }
  } else if (type === "response.function_call_arguments.delta") {
    const delta = chunk.delta as string | undefined;
    const callId = chunk.call_id as string | undefined;
    const itemId = chunk.item_id as string | undefined;
    const key = itemId ?? callId ?? "unknown";

    if (!state.toolCalls.has(0) || state.toolCalls.get(0)?.id !== key) {
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
        delta: { stop_reason: hasToolUse ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: state.outputTokens },
      }),
    );
    events.push(sseEvent("message_stop", { type: "message_stop" }));
    state.stopped = true;
  }

  return events;
}

// ─── SSE Stream Adapter ─────────────────────────────────────────────

export function createSSEStream(
  responseBody: ReadableStream<Uint8Array>,
  state: StreamState,
  chunkProcessor: (chunk: Record<string, unknown>, state: StreamState) => string[],
  onComplete?: () => void,
): ReadableStream<Uint8Array> {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  function closeStream(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (!state.stopped) {
      controller.enqueue(encoder.encode(sseEvent("message_stop", { type: "message_stop" })));
    }
    onComplete?.();
    controller.close();
  }

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          closeStream(controller);
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
            closeStream(controller);
            return;
          }

          const chunk = JSON.parse(dataStr) as Record<string, unknown>;
          const events = chunkProcessor(chunk, state);
          if (events.length > 0) {
            controller.enqueue(encoder.encode(events.join("")));
          }
        }
      }
    },
  });
}

// ─── Responses API Stream Collector (for non-streaming mode) ────────

export async function collectResponsesStream(
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
