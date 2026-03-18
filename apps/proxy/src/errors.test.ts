import { describe, expect, test } from "bun:test";
import { toAnthropicError, errorResponse } from "./errors.js";

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
