# engawa

Claude Code から GPT モデルをサブエージェントとして呼び出すためのプロキシ。

```
Claude Code → ANTHROPIC_BASE_URL=http://localhost:3131
                    ↓
              ┌─ engawa proxy (Hono) ─┐
              │  model ID で分岐:     │
              │  ├─ claude-* → Anthropic API (パススルー)
              │  └─ gpt-*   → OpenAI API (変換)
              └───────────────────────┘
```

## Install

```bash
npm install -g engawa
```

## Setup

### 1. 設定ファイル作成

```bash
# プロジェクトルートに engawa.config.ts を作成
cat > engawa.config.ts << 'EOF'
import { defineConfig } from "engawa"

export default defineConfig({
  routes: {
    "claude-*": { provider: "anthropic" },
    "gpt-5.4": { provider: "openai", model: "gpt-5.4" },
    "gpt-5.4-mini": { provider: "openai", model: "gpt-5.4-mini" },
    "o3": { provider: "openai", model: "o3" },
  },
})
EOF
```

### 2. サブエージェント定義を生成

```bash
engawa init
```

`.claude/agents/` に各モデルのエージェント定義が生成される:

```
.claude/agents/
├── gpt-5-4.md
├── gpt-5-4-mini.md
└── o3.md
```

### 3. 起動

```bash
# proxy + Claude Code を同時起動
engawa

# Claude Code にオプションを渡す
engawa -p "Hello"
engawa --model claude-opus-4-6

# proxy のみ起動
engawa --no-claude
```

## Usage

Claude Code 内でサブエージェントとして GPT を呼び出す:

```
Agent tool → subagent_type: "gpt-5-4" → GPT-5.4 が応答
```

## Config

```ts
interface RouteConfig {
  provider: "anthropic" | "openai"
  model?: string        // ルーティング先のモデル名
  apiKey?: string       // 環境変数名 or 直接値
  effort?: string       // OpenAI reasoning_effort (config固定)
}

interface EngawaConfig {
  port?: number         // default: 3131
  routes: Record<string, RouteConfig>
  verbose?: boolean     // default: true
}
```

### Effort

OpenAI の `reasoning_effort` は以下の優先順で解決:

1. **config の `effort`** — ルート設定で固定
2. **Claude Code の `output_config.effort`** — `/effort` コマンドで設定した値がパススルー

### OpenAI 認証

以下の順で認証情報を探す:

1. ルート設定の `apiKey`
2. `OPENAI_API_KEY` 環境変数
3. Codex CLI の OAuth (`~/.codex/auth.json`)

## Development

```bash
pnpm install
bun test          # テスト
pnpm lint         # oxlint
pnpm format       # oxfmt
pnpm dev          # 開発サーバー
```

## License

MIT
