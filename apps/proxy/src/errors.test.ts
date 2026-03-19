import { describe, expect, test } from "vitest";
import {
  toAnthropicError,
  errorResponse,
  authError,
  routeNotFoundError,
  providerError,
} from "./errors.js";

describe("toAnthropicError", () => {
  test("maps 400 to invalid_request_error", () => {
    const err = toAnthropicError(400, "bad request");
    expect(err.error.type).toBe("invalid_request_error");
  });

  test("maps 401 to authentication_error", () => {
    expect(toAnthropicError(401, "x").error.type).toBe("authentication_error");
  });

  test("maps 429 to rate_limit_error", () => {
    expect(toAnthropicError(429, "x").error.type).toBe("rate_limit_error");
  });

  test("maps 529 to overloaded_error", () => {
    expect(toAnthropicError(529, "x").error.type).toBe("overloaded_error");
  });

  test("maps 500 to api_error", () => {
    expect(toAnthropicError(500, "x").error.type).toBe("api_error");
  });
});

describe("errorResponse", () => {
  test("returns correct status and JSON body", async () => {
    const res = errorResponse(400, "test error");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.message).toBe("test error");
  });
});

describe("authError", () => {
  test("returns 401 with solution guidance", async () => {
    const res = authError();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toContain("OPENAI_API_KEY");
  });
});

describe("routeNotFoundError", () => {
  test("returns 400 with model name and config path", async () => {
    const res = routeNotFoundError("gpt-99");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("gpt-99");
    expect(body.error.message).toContain("config.ts");
  });
});

describe("providerError", () => {
  test("429 maps to rate_limit with hint", async () => {
    const res = providerError(429, "too many requests");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toContain("rate-limited");
  });

  test("401 maps to auth error with hint", async () => {
    const res = providerError(401, "unauthorized");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toContain("API key");
  });

  test("500 maps to 500 with no hint", async () => {
    const res = providerError(500, "internal error");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe("OpenAI API error: internal error");
  });

  test("unknown status maps to 500", async () => {
    const res = providerError(503, "unavailable");
    expect(res.status).toBe(500);
  });
});
