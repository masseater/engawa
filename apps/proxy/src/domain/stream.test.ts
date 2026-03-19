import { describe, expect, test } from "vitest";
import {
  sseEvent,
  createStreamState,
  processChatCompletionsChunk,
  processResponsesApiChunk,
  createSSEStream,
  collectResponsesStream,
} from "./stream.js";

function parseEvents(raw: string[]): Array<{ event: string; data: Record<string, unknown> }> {
  return raw.map((s) => {
    const lines = s.trim().split("\n");
    const event = lines[0]!.slice(7); // "event: X"
    const data = JSON.parse(lines[1]!.slice(6)); // "data: {...}"
    return { event, data };
  });
}

describe("sseEvent", () => {
  test("formats event correctly", () => {
    const result = sseEvent("test", { type: "test" });
    expect(result).toBe('event: test\ndata: {"type":"test"}\n\n');
  });
});

describe("processChatCompletionsChunk", () => {
  test("emits message_start on first chunk", () => {
    const state = createStreamState("gpt-5.4");
    const events = processChatCompletionsChunk(
      { choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
      state,
    );
    const parsed = parseEvents(events);
    expect(parsed[0]!.event).toBe("message_start");
    expect(parsed[1]!.event).toBe("content_block_start");
    expect(parsed[2]!.event).toBe("content_block_delta");
    expect(state.started).toBe(true);
  });

  test("does not emit message_start twice", () => {
    const state = createStreamState("gpt-5.4");
    processChatCompletionsChunk(
      { choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
      state,
    );
    const events = processChatCompletionsChunk(
      { choices: [{ delta: { content: " there" }, finish_reason: null }] },
      state,
    );
    const parsed = parseEvents(events);
    expect(parsed.every((e) => e.event !== "message_start")).toBe(true);
  });

  test("handles tool_calls delta", () => {
    const state = createStreamState("gpt-5.4");
    state.started = true;
    const events = processChatCompletionsChunk(
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_1", function: { name: "fn", arguments: '{"a"' } }],
            },
            finish_reason: null,
          },
        ],
      },
      state,
    );
    const parsed = parseEvents(events);
    expect(parsed.some((e) => e.event === "content_block_start")).toBe(true);
    expect(state.toolCalls.has(0)).toBe(true);
  });

  test("accumulates tool_call arguments", () => {
    const state = createStreamState("gpt-5.4");
    state.started = true;
    processChatCompletionsChunk(
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "fn", arguments: '{"a"' } }],
            },
            finish_reason: null,
          },
        ],
      },
      state,
    );
    processChatCompletionsChunk(
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] },
            finish_reason: null,
          },
        ],
      },
      state,
    );
    expect(state.toolCalls.get(0)!.arguments).toBe('{"a":1}');
  });

  test("closes text block when tool_calls arrive", () => {
    const state = createStreamState("gpt-5.4");
    state.started = true;
    processChatCompletionsChunk(
      { choices: [{ delta: { content: "thinking" }, finish_reason: null }] },
      state,
    );
    expect(state.currentTextBlockOpen).toBe(true);
    const events = processChatCompletionsChunk(
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "fn", arguments: "{}" } }],
            },
            finish_reason: null,
          },
        ],
      },
      state,
    );
    const parsed = parseEvents(events);
    expect(parsed.some((e) => e.event === "content_block_stop")).toBe(true);
    expect(state.currentTextBlockOpen).toBe(false);
  });

  test("finish_reason emits message_delta with stop_reason", () => {
    const state = createStreamState("gpt-5.4");
    state.started = true;
    const events = processChatCompletionsChunk(
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      state,
    );
    const parsed = parseEvents(events);
    const messageDelta = parsed.find((e) => e.event === "message_delta");
    expect(messageDelta).toBeDefined();
    expect((messageDelta!.data.delta as Record<string, string>).stop_reason).toBe("end_turn");
  });

  test("finish_reason closes open tool blocks", () => {
    const state = createStreamState("gpt-5.4");
    state.started = true;
    // Open a tool block
    processChatCompletionsChunk(
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "fn", arguments: "{}" } }],
            },
            finish_reason: null,
          },
        ],
      },
      state,
    );
    expect(state.openToolBlocks.size).toBe(1);

    // finish_reason should close the tool block
    const events = processChatCompletionsChunk(
      {
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      state,
    );
    const parsed = parseEvents(events);
    expect(parsed.some((e) => e.event === "content_block_stop")).toBe(true);
    expect(state.openToolBlocks.size).toBe(0);
    const messageDelta = parsed.find((e) => e.event === "message_delta");
    expect((messageDelta!.data.delta as Record<string, string>).stop_reason).toBe("tool_use");
  });

  test("finish_reason closes open text block", () => {
    const state = createStreamState("gpt-5.4");
    state.started = true;
    // Open a text block
    processChatCompletionsChunk(
      { choices: [{ delta: { content: "hello" }, finish_reason: null }] },
      state,
    );
    expect(state.currentTextBlockOpen).toBe(true);

    const events = processChatCompletionsChunk(
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      },
      state,
    );
    const parsed = parseEvents(events);
    const stops = parsed.filter((e) => e.event === "content_block_stop");
    expect(stops.length).toBeGreaterThanOrEqual(1);
    expect(state.currentTextBlockOpen).toBe(false);
  });

  test("usage-only chunk (no choices) captures token counts", () => {
    const state = createStreamState("gpt-5.4");
    state.started = true;
    processChatCompletionsChunk({ usage: { prompt_tokens: 100, completion_tokens: 50 } }, state);
    expect(state.inputTokens).toBe(100);
    expect(state.outputTokens).toBe(50);
  });

  test("empty delta returns only message_start events", () => {
    const state = createStreamState("gpt-5.4");
    const events = processChatCompletionsChunk(
      { choices: [{ delta: {}, finish_reason: null }] },
      state,
    );
    const parsed = parseEvents(events);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.event).toBe("message_start");
  });
});

describe("processResponsesApiChunk", () => {
  test("text delta emits content_block_start + content_block_delta", () => {
    const state = createStreamState("gpt-5.4");
    const events = processResponsesApiChunk(
      { type: "response.output_text.delta", delta: "Hello" },
      state,
    );
    const parsed = parseEvents(events);
    expect(parsed[0]!.event).toBe("message_start");
    expect(parsed[1]!.event).toBe("content_block_start");
    expect(parsed[2]!.event).toBe("content_block_delta");
  });

  test("text done closes text block", () => {
    const state = createStreamState("gpt-5.4");
    state.started = true;
    state.currentTextBlockOpen = true;
    const events = processResponsesApiChunk({ type: "response.output_text.done" }, state);
    const parsed = parseEvents(events);
    expect(parsed.some((e) => e.event === "content_block_stop")).toBe(true);
    expect(state.currentTextBlockOpen).toBe(false);
  });

  test("function_call_arguments.delta creates tool block", () => {
    const state = createStreamState("gpt-5.4");
    state.started = true;
    const events = processResponsesApiChunk(
      {
        type: "response.function_call_arguments.delta",
        delta: '{"x":1}',
        call_id: "c1",
        item_id: "item1",
        name: "fn",
      },
      state,
    );
    const parsed = parseEvents(events);
    expect(parsed.some((e) => e.event === "content_block_start")).toBe(true);
    expect(state.toolCalls.size).toBe(1);
  });

  test("function_call_arguments.done closes tool blocks", () => {
    const state = createStreamState("gpt-5.4");
    state.started = true;
    state.openToolBlocks.add(0);
    const events = processResponsesApiChunk(
      { type: "response.function_call_arguments.done" },
      state,
    );
    const parsed = parseEvents(events);
    expect(parsed.some((e) => e.event === "content_block_stop")).toBe(true);
    expect(state.openToolBlocks.size).toBe(0);
  });

  test("response.completed emits message_delta + message_stop", () => {
    const state = createStreamState("gpt-5.4");
    state.started = true;
    const events = processResponsesApiChunk(
      {
        type: "response.completed",
        response: {
          output: [{ type: "message" }],
          usage: { input_tokens: 20, output_tokens: 10 },
        },
      },
      state,
    );
    const parsed = parseEvents(events);
    expect(parsed.some((e) => e.event === "message_delta")).toBe(true);
    expect(parsed.some((e) => e.event === "message_stop")).toBe(true);
    expect(state.stopped).toBe(true);
    expect(state.inputTokens).toBe(20);
  });

  test("unrecognized event type emits only message_start", () => {
    const state = createStreamState("gpt-5.4");
    const events = processResponsesApiChunk({ type: "response.some_unknown_event" }, state);
    const parsed = parseEvents(events);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.event).toBe("message_start");
  });

  test("response.completed with function_call → tool_use stop_reason", () => {
    const state = createStreamState("gpt-5.4");
    state.started = true;
    const events = processResponsesApiChunk(
      {
        type: "response.completed",
        response: {
          output: [{ type: "function_call" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      state,
    );
    const parsed = parseEvents(events);
    const messageDelta = parsed.find((e) => e.event === "message_delta");
    expect((messageDelta!.data.delta as Record<string, string>).stop_reason).toBe("tool_use");
  });
});

describe("createSSEStream", () => {
  test("converts OpenAI SSE to Anthropic SSE", async () => {
    const encoder = new TextEncoder();
    const inputStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const state = createStreamState("gpt-5.4");
    const stream = createSSEStream(inputStream, state, processChatCompletionsChunk);
    const result = await new Response(stream).text();

    expect(result).toContain("event: message_start");
    expect(result).toContain("event: content_block_delta");
    expect(result).toContain("event: message_stop");
  });

  test("handles stream end without [DONE]", async () => {
    const encoder = new TextEncoder();
    const inputStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "x" }, finish_reason: null }] })}\n\n`,
          ),
        );
        controller.close();
      },
    });

    const state = createStreamState("gpt-5.4");
    const stream = createSSEStream(inputStream, state, processChatCompletionsChunk);
    const result = await new Response(stream).text();

    expect(result).toContain("event: message_stop");
  });
});

describe("collectResponsesStream", () => {
  test("extracts response.completed event", async () => {
    const encoder = new TextEncoder();
    const inputStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"response.output_text.delta","delta":"Hi"}\n'),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.completed","response":{"output":[{"type":"message"}],"usage":{"input_tokens":5}}}\n',
          ),
        );
        controller.close();
      },
    });

    const result = await collectResponsesStream(inputStream);
    expect(result).not.toBeNull();
    expect(result!.output).toBeDefined();
  });

  test("handles multiple data lines in single chunk", async () => {
    const encoder = new TextEncoder();
    const inputStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_text.delta","delta":"A"}\ndata: {"type":"response.output_text.delta","delta":"B"}\ndata: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":5}}}\n',
          ),
        );
        controller.close();
      },
    });

    const result = await collectResponsesStream(inputStream);
    expect(result).not.toBeNull();
  });

  test("returns null if no response.completed", async () => {
    const encoder = new TextEncoder();
    const inputStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"response.output_text.delta","delta":"x"}\n'),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n"));
        controller.close();
      },
    });

    const result = await collectResponsesStream(inputStream);
    expect(result).toBeNull();
  });
});
