interface AnthropicError {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}

function mapErrorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  return "api_error";
}

export function toAnthropicError(status: number, message: string): AnthropicError {
  return {
    type: "error",
    error: {
      type: mapErrorType(status),
      message,
    },
  };
}

export function errorResponse(status: number, message: string): Response {
  return Response.json(toAnthropicError(status, message), { status });
}

export function authError(): Response {
  return errorResponse(
    401,
    "OpenAI auth not configured. Set OPENAI_API_KEY env var, add apiKey to route config, or login to Codex CLI (codex login).",
  );
}

export function routeNotFoundError(modelId: string): Response {
  return errorResponse(
    400,
    `No route configured for model: ${modelId}. Check your engawa config at ~/.config/engawa/config.ts`,
  );
}

const providerErrorHints: Record<number, { status: number; hint: string }> = {
  401: { status: 401, hint: " Check your API key or OAuth session." },
  429: { status: 429, hint: " You may be rate-limited. Wait a moment and retry." },
};

export function providerError(status: number, upstream: string): Response {
  const { status: mapped, hint } = providerErrorHints[status] ?? { status: 500, hint: "" };
  return errorResponse(mapped, `OpenAI API error: ${upstream}${hint}`);
}
