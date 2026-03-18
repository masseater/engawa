import { defineConfig } from "engawa";

export default defineConfig({
  routes: {
    "claude-*": { provider: "anthropic" },
    "gpt-5.4": { provider: "openai", model: "gpt-5.4" },
    "gpt-5.4-mini": { provider: "openai", model: "gpt-5.4-mini" },
    o3: { provider: "openai", model: "o3" },
  },
});
