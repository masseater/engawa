import { describe, expect, test } from "vitest";
import {
  convertFinishReason,
  generateId,
  buildChatCompletionsRequest,
  buildResponsesApiRequest,
  convertChatCompletionsResponse,
  convertResponsesApiResponse,
  resolveEffort,
} from "./convert.js";
import type { ResolvedRoute } from "../types.js";

const route: ResolvedRoute = {
  pattern: "gpt-5.4",
  config: { provider: "openai", model: "gpt-5.4" },
  targetModel: "gpt-5.4",
};

describe("convertFinishReason", () => {
  test("tool_calls → tool_use", () => expect(convertFinishReason("tool_calls")).toBe("tool_use"));
  test("length → max_tokens", () => expect(convertFinishReason("length")).toBe("max_tokens"));
  test("stop → end_turn", () => expect(convertFinishReason("stop")).toBe("end_turn"));
  test("content_filter → end_turn", () =>
    expect(convertFinishReason("content_filter")).toBe("end_turn"));
  test("null → end_turn", () => expect(convertFinishReason(null)).toBe("end_turn"));
  test("unknown → end_turn", () => expect(convertFinishReason("whatever")).toBe("end_turn"));
});

describe("generateId", () => {
  test("starts with msg_", () => expect(generateId()).toMatch(/^msg_/));
  test("generates unique ids", () => expect(generateId()).not.toBe(generateId()));
});

describe("resolveEffort", () => {
  test("returns route config effort if set", () => {
    const r: ResolvedRoute = { ...route, config: { ...route.config, effort: "high" } };
    expect(resolveEffort({}, r)).toBe("high");
  });

  test("returns output_config.effort from body", () => {
    expect(resolveEffort({ output_config: { effort: "low" } }, route)).toBe("low");
  });

  test("route config takes precedence over body", () => {
    const r: ResolvedRoute = { ...route, config: { ...route.config, effort: "high" } };
    expect(resolveEffort({ output_config: { effort: "low" } }, r)).toBe("high");
  });

  test("returns undefined when no effort configured", () => {
    expect(resolveEffort({}, route)).toBeUndefined();
  });
});

describe("buildChatCompletionsRequest", () => {
  test("basic text message", () => {
    const req = buildChatCompletionsRequest(
      { messages: [{ role: "user", content: "Hi" }], max_tokens: 100 },
      route,
    );
    expect(req.model).toBe("gpt-5.4");
    expect(req.max_tokens).toBe(100);
    const msgs = req.messages as Array<{ role: string; content: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toBe("Hi");
  });

  test("string system message → developer role", () => {
    const req = buildChatCompletionsRequest(
      { system: "Be helpful", messages: [{ role: "user", content: "Hi" }], max_tokens: 10 },
      route,
    );
    const msgs = req.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]!.role).toBe("developer");
    expect(msgs[0]!.content).toBe("Be helpful");
  });

  test("array system message → developer role with joined text", () => {
    const req = buildChatCompletionsRequest(
      {
        system: [
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
        ],
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 10,
      },
      route,
    );
    const msgs = req.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]!.role).toBe("developer");
    expect(msgs[0]!.content).toBe("Line 1\nLine 2");
  });

  test("empty array system → no developer message", () => {
    const req = buildChatCompletionsRequest(
      { system: [], messages: [{ role: "user", content: "Hi" }], max_tokens: 10 },
      route,
    );
    const msgs = req.messages as Array<{ role: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
  });

  test("converts tool_use blocks to tool_calls", () => {
    const req = buildChatCompletionsRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "get_weather", input: { city: "Tokyo" } },
            ],
          },
        ],
        max_tokens: 10,
      },
      route,
    );
    const msgs = req.messages as Array<{
      role: string;
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    }>;
    expect(msgs[0]!.tool_calls).toHaveLength(1);
    expect(msgs[0]!.tool_calls![0]!.function.name).toBe("get_weather");
    expect(JSON.parse(msgs[0]!.tool_calls![0]!.function.arguments)).toEqual({ city: "Tokyo" });
  });

  test("converts tool_result blocks to tool role messages", () => {
    const req = buildChatCompletionsRequest(
      {
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "Sunny, 25C" }],
          },
        ],
        max_tokens: 10,
      },
      route,
    );
    const msgs = req.messages as Array<{ role: string; content: string; tool_call_id?: string }>;
    expect(msgs[0]!.role).toBe("tool");
    expect(msgs[0]!.tool_call_id).toBe("t1");
    expect(msgs[0]!.content).toBe("Sunny, 25C");
  });

  test("tool_result with array content", () => {
    const req = buildChatCompletionsRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "text", text: "result" }],
              },
            ],
          },
        ],
        max_tokens: 10,
      },
      route,
    );
    const msgs = req.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]!.content).toBe("result");
  });

  test("tool_result with is_error", () => {
    const req = buildChatCompletionsRequest(
      {
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "fail", is_error: true }],
          },
        ],
        max_tokens: 10,
      },
      route,
    );
    const msgs = req.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]!.content).toBe("[Error] fail");
  });

  test("tool_result with no content", () => {
    const req = buildChatCompletionsRequest(
      {
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1" }],
          },
        ],
        max_tokens: 10,
      },
      route,
    );
    const msgs = req.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]!.content).toBe("");
  });

  test("includes optional parameters", () => {
    const req = buildChatCompletionsRequest(
      {
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 10,
        temperature: 0.5,
        top_p: 0.9,
        stop_sequences: ["\n"],
      },
      route,
    );
    expect(req.temperature).toBe(0.5);
    expect(req.top_p).toBe(0.9);
    expect(req.stop).toEqual(["\n"]);
  });

  test("includes tools when provided", () => {
    const req = buildChatCompletionsRequest(
      {
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 10,
        tools: [{ name: "fn", description: "desc", input_schema: { type: "object" } }],
      },
      route,
    );
    const tools = req.tools as Array<{ type: string; function: { name: string } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type).toBe("function");
    expect(tools[0]!.function.name).toBe("fn");
  });

  test("streaming request sets stream options", () => {
    const req = buildChatCompletionsRequest(
      { messages: [{ role: "user", content: "Hi" }], max_tokens: 10, stream: true },
      route,
    );
    expect(req.stream).toBe(true);
    expect(req.stream_options).toEqual({ include_usage: true });
  });

  test("assistant message with text + tool_use", () => {
    const req = buildChatCompletionsRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check" },
              { type: "tool_use", id: "t1", name: "search", input: { q: "test" } },
            ],
          },
        ],
        max_tokens: 10,
      },
      route,
    );
    const msgs = req.messages as Array<{
      role: string;
      content: string | null;
      tool_calls?: Array<Record<string, unknown>>;
    }>;
    expect(msgs[0]!.content).toBe("Let me check");
    expect(msgs[0]!.tool_calls).toHaveLength(1);
  });

  test("user message with text blocks (no tool_use)", () => {
    const req = buildChatCompletionsRequest(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        max_tokens: 10,
      },
      route,
    );
    const msgs = req.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]!.content).toBe("Hello");
  });
});

describe("buildResponsesApiRequest", () => {
  test("basic text message", () => {
    const req = buildResponsesApiRequest(
      { messages: [{ role: "user", content: "Hi" }], max_tokens: 10 },
      route,
    );
    expect(req.model).toBe("gpt-5.4");
    expect(req.stream).toBe(true);
    expect(req.store).toBe(false);
    const input = req.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]!.type).toBe("message");
  });

  test("string system → instructions", () => {
    const req = buildResponsesApiRequest(
      { system: "Be helpful", messages: [{ role: "user", content: "Hi" }], max_tokens: 10 },
      route,
    );
    expect(req.instructions).toBe("Be helpful");
  });

  test("array system → instructions joined", () => {
    const req = buildResponsesApiRequest(
      {
        system: [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 10,
      },
      route,
    );
    expect(req.instructions).toBe("A\nB");
  });

  test("converts tool_use blocks to function_call input", () => {
    const req = buildResponsesApiRequest(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "fn", input: { x: 1 } }],
          },
        ],
        max_tokens: 10,
      },
      route,
    );
    const input = req.input as Array<Record<string, unknown>>;
    expect(input[0]!.type).toBe("function_call");
    expect(input[0]!.call_id).toBe("t1");
    expect(input[0]!.arguments).toBe('{"x":1}');
  });

  test("converts tool_result blocks to function_call_output", () => {
    const req = buildResponsesApiRequest(
      {
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }],
          },
        ],
        max_tokens: 10,
      },
      route,
    );
    const input = req.input as Array<Record<string, unknown>>;
    expect(input[0]!.type).toBe("function_call_output");
    expect(input[0]!.output).toBe("result");
  });

  test("tool_result with array content", () => {
    const req = buildResponsesApiRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "text", text: "ok" }],
              },
            ],
          },
        ],
        max_tokens: 10,
      },
      route,
    );
    const input = req.input as Array<Record<string, unknown>>;
    expect(input[0]!.output).toBe("ok");
  });

  test("includes tools and effort", () => {
    const r: ResolvedRoute = { ...route, config: { ...route.config, effort: "high" } };
    const req = buildResponsesApiRequest(
      {
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 10,
        tools: [{ name: "fn", description: "d", input_schema: { type: "object" } }],
      },
      r,
    );
    expect(req.tools).toHaveLength(1);
    expect(req.reasoning).toEqual({ effort: "high" });
  });

  test("text blocks in content array", () => {
    const req = buildResponsesApiRequest(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        max_tokens: 10,
      },
      route,
    );
    const input = req.input as Array<Record<string, unknown>>;
    expect(input[0]!.type).toBe("message");
  });
});

describe("convertChatCompletionsResponse", () => {
  test("basic text response", () => {
    const res = convertChatCompletionsResponse(
      {
        choices: [{ message: { content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      },
      "gpt-5.4",
    );
    expect(res.type).toBe("message");
    expect(res.role).toBe("assistant");
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toBe("Hi");
    expect(res.stop_reason).toBe("end_turn");
    const usage = res.usage as { input_tokens: number; output_tokens: number };
    expect(usage.input_tokens).toBe(5);
    expect(usage.output_tokens).toBe(1);
  });

  test("tool_calls response", () => {
    const res = convertChatCompletionsResponse(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c1", function: { name: "fn", arguments: '{"a":1}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      "gpt-5.4",
    );
    expect(res.stop_reason).toBe("tool_use");
    const content = res.content as Array<Record<string, unknown>>;
    expect(content[0]!.type).toBe("tool_use");
    expect(content[0]!.name).toBe("fn");
    expect(content[0]!.input).toEqual({ a: 1 });
  });

  test("empty choices returns empty content", () => {
    const res = convertChatCompletionsResponse({ choices: [] }, "gpt-5.4");
    expect(res.content as Array<unknown>).toHaveLength(0);
    expect(res.stop_reason).toBe("end_turn");
  });

  test("no usage returns zeros", () => {
    const res = convertChatCompletionsResponse(
      { choices: [{ message: { content: "x" }, finish_reason: "stop" }] },
      "gpt-5.4",
    );
    const usage = res.usage as { input_tokens: number; output_tokens: number };
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
  });
});

describe("convertResponsesApiResponse", () => {
  test("text output", () => {
    const res = convertResponsesApiResponse(
      {
        output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }],
        usage: { input_tokens: 10, output_tokens: 3 },
      },
      "gpt-5.4",
    );
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toBe("Hello");
    expect(res.stop_reason).toBe("end_turn");
  });

  test("function_call output → tool_use", () => {
    const res = convertResponsesApiResponse(
      {
        output: [{ type: "function_call", call_id: "c1", name: "fn", arguments: '{"a":1}' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "gpt-5.4",
    );
    expect(res.stop_reason).toBe("tool_use");
    const content = res.content as Array<Record<string, unknown>>;
    expect(content[0]!.type).toBe("tool_use");
    expect(content[0]!.input).toEqual({ a: 1 });
  });

  test("incomplete status → max_tokens", () => {
    const res = convertResponsesApiResponse(
      {
        status: "incomplete",
        output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
        usage: { input_tokens: 10, output_tokens: 100 },
      },
      "gpt-5.4",
    );
    expect(res.stop_reason).toBe("max_tokens");
  });

  test("no output returns empty content", () => {
    const res = convertResponsesApiResponse(
      { usage: { input_tokens: 0, output_tokens: 0 } },
      "gpt-5.4",
    );
    expect(res.content as Array<unknown>).toHaveLength(0);
  });
});
