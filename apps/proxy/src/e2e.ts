#!/usr/bin/env tsx
/**
 * E2E smoke test — starts the proxy and sends real requests to OpenAI.
 * Usage: tsx src/e2e.ts
 */
import { startServer } from "./index.js";
import { loadConfig } from "./config.js";

function makeRequest(model: string, overrides: Record<string, unknown> = {}) {
  return {
    model,
    system: "You are a helpful assistant. Reply in one short sentence.",
    messages: [{ role: "user", content: "Say hello." }],
    max_tokens: 256,
    stream: false,
    ...overrides,
  };
}

function post(proxyUrl: string, body: Record<string, unknown>) {
  return fetch(`${proxyUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ok(label: string) {
  console.log(`  ✔ ${label}`);
}

function fail(label: string, detail: string) {
  console.error(`  ✘ ${label}: ${detail}`);
  process.exitCode = 1;
}

function parseSSEEvents(text: string) {
  const blocks = text.split("\n\n").filter((s) => s.trim());
  const eventTypes = blocks
    .map((block) => block.split("\n").find((l) => l.startsWith("event: "))?.slice(7))
    .filter((x): x is string => x !== undefined);
  return { blocks, eventTypes };
}

function extractTextDeltas(blocks: string[]): string {
  return blocks
    .filter((block) => block.includes('"text_delta"'))
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) return "";
      const data = JSON.parse(dataLine.slice(6)) as { delta?: { text?: string } };
      return data.delta?.text ?? "";
    })
    .join("");
}

const weatherTool = {
  name: "get_weather",
  description: "Get the weather for a city",
  input_schema: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
};

async function testNonStreaming(proxyUrl: string, model: string) {
  console.log("\n[non-streaming]");
  const res = await post(proxyUrl, makeRequest(model));

  if (!res.ok) {
    fail("response", `status ${res.status}: ${await res.text()}`);
    return;
  }

  const body = (await res.json()) as Record<string, unknown>;
  if (body.type !== "message") {
    fail("type", `expected "message", got "${body.type}"`);
    return;
  }
  ok(`type=${body.type}`);

  const content = body.content as Array<{ type: string; text?: string }>;
  if (!content?.[0]?.text) {
    fail("content", `no text block: ${JSON.stringify(content)}`);
    return;
  }
  ok(`text="${content[0].text.slice(0, 60)}..."`);

  const usage = body.usage as Record<string, number>;
  if (!usage?.input_tokens || !usage?.output_tokens) {
    fail("usage", JSON.stringify(usage));
    return;
  }
  ok(`usage: in=${usage.input_tokens} out=${usage.output_tokens}`);
}

async function testMultiTurn(proxyUrl: string, model: string) {
  console.log("\n[multi-turn (assistant output_text)]");
  const res = await post(proxyUrl, makeRequest(model, {
    system: "Reply in one word.",
    messages: [
      { role: "user", content: "Say hello." },
      { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
      { role: "user", content: "Now say goodbye." },
    ],
  }));

  if (!res.ok) {
    fail("response", `status ${res.status}: ${await res.text()}`);
    return;
  }

  const body = (await res.json()) as Record<string, unknown>;
  const content = body.content as Array<{ type: string; text?: string }>;
  if (!content?.[0]?.text) {
    fail("content", `no text block: ${JSON.stringify(content)}`);
    return;
  }
  ok(`text="${content[0].text.slice(0, 60)}"`);
}

async function testStreaming(proxyUrl: string, model: string) {
  console.log("\n[streaming]");
  const res = await post(proxyUrl, makeRequest(model, { stream: true }));

  if (!res.ok) {
    fail("response", `status ${res.status}: ${await res.text()}`);
    return;
  }

  const { blocks, eventTypes } = parseSSEEvents(await res.text());

  for (const evt of ["message_start", "content_block_start", "content_block_delta", "message_stop"]) {
    if (eventTypes.includes(evt)) ok(evt);
    else fail(evt, `missing from stream (got: ${eventTypes.join(", ")})`);
  }

  ok(`streamed text="${extractTextDeltas(blocks).slice(0, 60)}..."`);
}

async function testToolUse(proxyUrl: string, model: string) {
  console.log("\n[tool_use round-trip]");

  const res1 = await post(proxyUrl, {
    model,
    system: "Use the get_weather tool to answer weather questions.",
    messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
    max_tokens: 512,
    tools: [weatherTool],
    stream: false,
  });

  if (!res1.ok) {
    fail("tool_use request", `status ${res1.status}: ${await res1.text()}`);
    return;
  }

  const body1 = (await res1.json()) as Record<string, unknown>;
  const content1 = body1.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>;
  const toolUseBlock = content1?.find((c) => c.type === "tool_use");

  if (!toolUseBlock) {
    fail("tool_use", `no tool_use block: ${JSON.stringify(content1?.map((c) => c.type))}`);
    return;
  }
  ok(`tool_use: ${toolUseBlock.name}(${JSON.stringify(toolUseBlock.input)})`);

  if (body1.stop_reason !== "tool_use") {
    fail("stop_reason", `expected "tool_use", got "${body1.stop_reason}"`);
    return;
  }
  ok(`stop_reason=tool_use`);

  const res2 = await post(proxyUrl, {
    model,
    system: "Use the get_weather tool to answer weather questions.",
    messages: [
      { role: "user", content: "What's the weather in Tokyo?" },
      { role: "assistant", content: content1 },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseBlock.id, content: "Sunny, 25°C" }] },
    ],
    max_tokens: 512,
    tools: [weatherTool],
    stream: false,
  });

  if (!res2.ok) {
    fail("tool_result follow-up", `status ${res2.status}: ${await res2.text()}`);
    return;
  }

  const body2 = (await res2.json()) as Record<string, unknown>;
  const content2 = body2.content as Array<{ type: string; text?: string }>;
  const textBlock = content2?.find((c) => c.type === "text");
  if (!textBlock?.text) {
    fail("tool_result response", `no text: ${JSON.stringify(content2?.map((c) => c.type))}`);
    return;
  }
  ok(`response after tool_result: "${textBlock.text.slice(0, 80)}..."`);
}

async function testThinking(proxyUrl: string, model: string) {
  console.log("\n[thinking / reasoning effort]");
  const res = await post(proxyUrl, makeRequest(model, {
    system: "Reply in one sentence.",
    messages: [{ role: "user", content: "What is 2+2?" }],
    max_tokens: 1024,
    thinking: { budget_tokens: 1023, type: "enabled" },
    output_config: { effort: "medium" },
    stream: true,
  }));

  if (!res.ok) {
    fail("response", `status ${res.status}: ${await res.text()}`);
    return;
  }

  const { blocks, eventTypes } = parseSSEEvents(await res.text());

  if (eventTypes.includes("message_start") && eventTypes.includes("message_stop")) {
    ok("stream complete");
  } else {
    fail("stream", `missing events (got: ${eventTypes.join(", ")})`);
  }

  const text = extractTextDeltas(blocks);
  if (text.length > 0) ok(`text="${text.slice(0, 60)}"`);
  else fail("text", "no text deltas in stream");
}

async function testStreamingToolUse(proxyUrl: string, model: string) {
  console.log("\n[streaming tool_use]");
  const res = await post(proxyUrl, {
    model,
    system: "Always use the get_time tool. Do not respond with text.",
    messages: [{ role: "user", content: "What time is it?" }],
    max_tokens: 512,
    tools: [{ name: "get_time", description: "Get the current time", input_schema: { type: "object", properties: {}, required: [] } }],
    stream: true,
  });

  if (!res.ok) {
    fail("response", `status ${res.status}: ${await res.text()}`);
    return;
  }

  const { blocks } = parseSSEEvents(await res.text());

  if (blocks.some((b) => b.includes('"tool_use"'))) {
    ok("tool_use content_block_start");
  } else if (extractTextDeltas(blocks).length > 0) {
    ok("model responded with text instead of tool (acceptable)");
  } else {
    fail("tool_use", "no tool_use block and no text in stream");
  }

  if (blocks.some((b) => b.includes('"input_json_delta"'))) ok("input_json_delta streamed");
  if (blocks.some((b) => b.includes('"message_delta"'))) ok("message_delta present");
  else fail("message_delta", "missing from stream");
}

async function main() {
  const config = await loadConfig();
  const route = Object.entries(config.routes).find(([, r]) => r.provider === "openai");
  if (!route) {
    console.error("No OpenAI route in config. Add one to engawa.config.ts.");
    process.exit(1);
  }
  const model = route[0];

  console.log("Starting proxy...");
  const server = await startServer({ ...config, verbose: true });
  const proxyUrl = `http://localhost:${server.port}`;
  console.log(`Proxy ready at ${proxyUrl}`);

  try {
    await testNonStreaming(proxyUrl, model);
    await testMultiTurn(proxyUrl, model);
    await testStreaming(proxyUrl, model);
    await testToolUse(proxyUrl, model);
    await testThinking(proxyUrl, model);
    await testStreamingToolUse(proxyUrl, model);
  } finally {
    server.stop();
  }

  console.log(process.exitCode ? "\nSome tests failed." : "\nAll tests passed.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
