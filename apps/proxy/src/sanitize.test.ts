import { describe, expect, test } from "vitest";
import { sanitizeBody } from "./sanitize.js";

describe("sanitizeBody", () => {
  test("returns body unchanged when no issues", () => {
    const body = {
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "fn", input_schema: {} }],
    };
    expect(sanitizeBody(body)).toBe(body); // same reference
  });

  test("returns body unchanged when no messages", () => {
    const body = { model: "gpt-5.4" };
    expect(sanitizeBody(body)).toBe(body);
  });

  test("removes tool_use blocks with empty name", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "tool_use", id: "t1", name: "", input: {} },
          ],
        },
      ],
    };
    const cleaned = sanitizeBody(body);
    const content = (cleaned.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!
      .content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe("text");
  });

  test("removes orphan tool_result for empty-name tool_use", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "result" },
            { type: "text", text: "other" },
          ],
        },
      ],
    };
    const cleaned = sanitizeBody(body);
    const msgs = cleaned.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msgs[1]!.content).toHaveLength(1);
    expect(msgs[1]!.content[0]!.type).toBe("text");
  });

  test("removes tools with empty name", () => {
    const body = {
      messages: [{ role: "user", content: "Hi" }],
      tools: [
        { name: "valid_fn", input_schema: {} },
        { name: "", input_schema: {} },
      ],
    };
    const cleaned = sanitizeBody(body);
    const tools = cleaned.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("valid_fn");
  });

  test("preserves string content messages", () => {
    const body = {
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "", input: {} }],
        },
      ],
    };
    const cleaned = sanitizeBody(body);
    const msgs = cleaned.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0]!.content).toBe("Hello");
  });

  test("tool_use with name but no empty-name tools → no change", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "valid", input: {} }],
        },
      ],
    };
    expect(sanitizeBody(body)).toBe(body);
  });
});
