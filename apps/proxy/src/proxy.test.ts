import { describe, expect, test, afterAll, beforeAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { startServer } from "./index.js";

// Mock OpenAI API
const mockApp = new Hono();
let lastOpenAIRequest: Record<string, unknown> | null = null;

mockApp.post("/v1/chat/completions", async (c) => {
  lastOpenAIRequest = await c.req.json();

  if (lastOpenAIRequest!.stream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const chunks = [
          {
            id: "c-1",
            choices: [
              { index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null },
            ],
          },
          { id: "c-1", choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] },
          {
            id: "c-1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          },
        ];
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }

  const tools = lastOpenAIRequest!.tools as Array<Record<string, unknown>> | undefined;
  if (tools && tools.length > 0) {
    return c.json({
      id: "chatcmpl-test",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 15 },
    });
  }

  return c.json({
    id: "chatcmpl-test",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello from mock!" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
});

// Mock Anthropic API
const mockAnthropicApp = new Hono();

mockAnthropicApp.post("/v1/messages", async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  if (body.stream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: body.model, stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Anthropic hello" } })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }
  return c.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello from Anthropic mock!" }],
    model: body.model,
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 3 },
  });
});

mockAnthropicApp.post("/v1/messages/count_tokens", async (c) => {
  return c.json({ input_tokens: 42 });
});

let mockOpenAI: ServerType;
let mockUrl: string;
let mockAnthropicServer: ServerType;
let mockAnthropicUrl: string;
let proxy: { port: number; stop: () => void };
let proxyUrl: string;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  // Start mock OpenAI server
  await new Promise<void>((resolve) => {
    mockOpenAI = serve({ fetch: mockApp.fetch, port: 0 }, (info) => {
      mockUrl = `http://localhost:${info.port}`;
      resolve();
    });
  });

  // Start mock Anthropic server
  await new Promise<void>((resolve) => {
    mockAnthropicServer = serve({ fetch: mockAnthropicApp.fetch, port: 0 }, (info) => {
      mockAnthropicUrl = `http://localhost:${info.port}`;
      resolve();
    });
  });

  // Intercept fetch to redirect API calls to mocks
  Object.defineProperty(globalThis, "fetch", {
    value: (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.openai.com/")) {
        const newUrl = url.replace("https://api.openai.com", mockUrl);
        return originalFetch(newUrl, init);
      }
      if (url.startsWith("https://api.anthropic.com/")) {
        const newUrl = url.replace("https://api.anthropic.com", mockAnthropicUrl);
        return originalFetch(newUrl, init);
      }
      return originalFetch(input, init);
    },
    writable: true,
    configurable: true,
  });

  process.env.OPENAI_API_KEY = "sk-test-fake";

  proxy = await startServer({
    port: 0,
    verbose: false,
    routes: {
      "claude-*": { provider: "anthropic" },
      "gpt-5.4": { provider: "openai", model: "gpt-5.4", effort: "medium" },
      "gpt-5.4-mini": { provider: "openai", model: "gpt-5.4-mini" },
    },
  });
  proxyUrl = `http://localhost:${proxy.port}`;
});

afterAll(() => {
  proxy.stop();
  mockOpenAI.close();
  mockAnthropicServer.close();
  Object.defineProperty(globalThis, "fetch", {
    value: originalFetch,
    writable: true,
    configurable: true,
  });
  delete process.env.OPENAI_API_KEY;
});

function post(path: string, body: Record<string, unknown>) {
  return fetch(`${proxyUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("proxy - non-streaming", () => {
  test("converts basic text request/response", async () => {
    const res = await post("/v1/messages", {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0].type).toBe("text");
    expect(body.content[0].text).toBe("Hello from mock!");
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage.input_tokens).toBe(10);
    expect(body.usage.output_tokens).toBe(5);
  });

  test("sends reasoning effort to OpenAI", async () => {
    await post("/v1/messages", {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
    });

    expect(lastOpenAIRequest).not.toBeNull();
    const req = lastOpenAIRequest as Record<string, Record<string, string>>;
    expect(req.reasoning).toEqual({ effort: "medium" });
  });

  test("converts system message to developer role", async () => {
    await post("/v1/messages", {
      model: "gpt-5.4",
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
    });

    const messages = (lastOpenAIRequest as Record<string, unknown>).messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0]!.role).toBe("developer");
    expect(messages[0]!.content).toBe("You are helpful.");
  });

  test("converts tool_calls response to tool_use", async () => {
    const res = await post("/v1/messages", {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Weather?" }],
      max_tokens: 100,
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });

    const body = await res.json();
    expect(body.stop_reason).toBe("tool_use");
    const toolUse = body.content.find((c: { type: string }) => c.type === "tool_use");
    expect(toolUse.name).toBe("get_weather");
    expect(toolUse.input).toEqual({ city: "Tokyo" });
  });

  test("returns error for unknown model", async () => {
    const res = await post("/v1/messages", {
      model: "unknown",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });
});

interface SSEEvent {
  event: string | undefined;
  data: Record<string, unknown> | null;
}

function parseSSE(text: string): SSEEvent[] {
  return text
    .split("\n\n")
    .filter((s) => s.trim())
    .map((block) => {
      const eventLine = block.split("\n").find((l) => l.startsWith("event: "));
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      return {
        event: eventLine?.slice(7),
        data: dataLine ? JSON.parse(dataLine.slice(6)) : null,
      };
    });
}

describe("proxy - error handling", () => {
  test("returns 400 when model field is missing", async () => {
    const res = await post("/v1/messages", {
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("model");
  });

  test("count_tokens returns 400 for OpenAI models", async () => {
    const res = await fetch(`${proxyUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("not supported");
  });
});

describe("proxy - health", () => {
  test("GET /health returns ok", async () => {
    const res = await fetch(`${proxyUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

describe("proxy - anthropic passthrough", () => {
  test("forwards request to Anthropic API and returns response", async () => {
    const res = await post("/v1/messages", {
      model: "claude-opus-4-20250514",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("message");
    expect(body.content[0].text).toBe("Hello from Anthropic mock!");
  });

  test("streams Anthropic response as passthrough", async () => {
    const res = await post("/v1/messages", {
      model: "claude-opus-4-20250514",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("message_start");
    expect(text).toContain("Anthropic hello");
  });

  test("count_tokens passes through to Anthropic", async () => {
    const res = await fetch(`${proxyUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.input_tokens).toBe(42);
  });
});

describe("proxy - streaming", () => {
  test("converts streaming response to Anthropic SSE", async () => {
    const res = await post("/v1/messages", {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const events = parseSSE(await res.text());
    const eventTypes = events.map((e) => e.event);

    expect(eventTypes).toContain("message_start");
    expect(eventTypes).toContain("content_block_start");
    expect(eventTypes).toContain("content_block_delta");
    expect(eventTypes).toContain("content_block_stop");
    expect(eventTypes).toContain("message_delta");
    expect(eventTypes).toContain("message_stop");

    const textDeltas = events
      .filter((e) => {
        if (e.event !== "content_block_delta" || !e.data) return false;
        const delta = (e.data as Record<string, Record<string, string>>).delta;
        return delta?.type === "text_delta";
      })
      .map((e) => {
        const delta = (e.data as Record<string, Record<string, string>>).delta!;
        return delta.text;
      });
    expect(textDeltas.join("")).toBe("Hello world");

    const messageDelta = events.find((e) => e.event === "message_delta")!;
    const delta = (messageDelta.data as Record<string, Record<string, string>>).delta!;
    expect(delta.stop_reason).toBe("end_turn");
  });
});
