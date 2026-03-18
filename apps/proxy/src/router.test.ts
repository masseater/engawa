import { describe, expect, test } from "bun:test";
import { resolveRoute } from "./router.js";
import type { EngawaConfig } from "./types.js";

const config: EngawaConfig = {
  port: 3131,
  routes: {
    "claude-*": { provider: "anthropic" },
    "gpt-5.4": { provider: "openai", model: "gpt-5.4", effort: "medium" },
    "gpt-5.4-mini": { provider: "openai", model: "gpt-5.4-mini" },
    o3: { provider: "openai", model: "o3", effort: "medium" },
  },
};

describe("resolveRoute", () => {
  test("matches exact model ID", () => {
    const route = resolveRoute("gpt-5.4", config);
    expect(route).not.toBeNull();
    expect(route!.config.provider).toBe("openai");
    expect(route!.targetModel).toBe("gpt-5.4");
    expect(route!.config.effort).toBe("medium");
  });

  test("matches wildcard pattern", () => {
    const route = resolveRoute("claude-opus-4-20250514", config);
    expect(route).not.toBeNull();
    expect(route!.config.provider).toBe("anthropic");
    expect(route!.targetModel).toBe("claude-opus-4-20250514");
  });

  test("returns null for unknown model", () => {
    expect(resolveRoute("unknown-model", config)).toBeNull();
  });

  test("no effort for non-reasoning model", () => {
    const route = resolveRoute("gpt-5.4-mini", config);
    expect(route!.config.effort).toBeUndefined();
  });
});
