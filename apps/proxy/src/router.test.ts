import { describe, expect, test } from "vitest";
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

  test("strips effort suffix and merges effort", () => {
    // gpt-5.4-mini has no effort configured, so suffix should apply
    const effortConfig: EngawaConfig = {
      routes: {
        "o3-bare": { provider: "openai", model: "o3-bare" },
      },
    };
    const route = resolveRoute("o3-bare-high", effortConfig);
    expect(route).not.toBeNull();
    expect(route!.config.provider).toBe("openai");
    expect(route!.targetModel).toBe("o3-bare");
    expect(route!.config.effort).toBe("high");
  });

  test("route config effort takes precedence over suffix", () => {
    // o3 route has effort: "medium", so suffix "low" should be ignored
    const route = resolveRoute("o3-low", config);
    expect(route).not.toBeNull();
    expect(route!.config.effort).toBe("medium");
  });

  test("effort suffix with unknown base model returns null", () => {
    expect(resolveRoute("unknown-high", config)).toBeNull();
  });

  test("wildcard pattern does not match effort-stripped model", () => {
    // "claude-opus-high" should match "claude-*" directly, not effort-strip
    const route = resolveRoute("claude-opus-high", config);
    expect(route).not.toBeNull();
    expect(route!.config.provider).toBe("anthropic");
    expect(route!.targetModel).toBe("claude-opus-high");
  });

  test("first matching route wins (insertion order)", () => {
    const multiConfig: EngawaConfig = {
      routes: {
        "gpt-*": { provider: "openai", model: "gpt-fallback" },
        "gpt-5.4": { provider: "openai", model: "gpt-5.4" },
      },
    };
    const route = resolveRoute("gpt-5.4", multiConfig);
    expect(route!.targetModel).toBe("gpt-fallback"); // wildcard matches first
  });

  test("all effort levels are recognized as suffixes", () => {
    const bareConfig: EngawaConfig = {
      routes: { mymodel: { provider: "openai", model: "mymodel" } },
    };
    for (const level of ["xhigh", "high", "medium", "low", "minimal", "none"]) {
      const route = resolveRoute(`mymodel-${level}`, bareConfig);
      expect(route, `mymodel-${level} should match`).not.toBeNull();
      expect(route!.config.effort).toBe(level);
    }
  });
});
