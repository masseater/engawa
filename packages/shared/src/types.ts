export interface RouteConfig {
  provider: "anthropic" | "openai";
  model?: string;
  apiKey?: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface EngawaConfig {
  port?: number;
  routes: Record<string, RouteConfig>;
  verbose?: boolean;
}

export interface AnthropicContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  stop_sequences?: string[];
  metadata?: unknown;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface AnthropicStreamEvent {
  type: string;
  [key: string]: unknown;
}
