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
