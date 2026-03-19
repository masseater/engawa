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
npm install -g @r_masseater/engawa
```

Node.js >= 22 と OpenAI 認証情報（環境変数 or [Codex CLI](https://github.com/openai/codex) auth）が必要。

## Setup

### 1. 設定ファイル作成

```bash
# プロジェクトルートに engawa.config.ts を作成
cat > engawa.config.ts << 'EOF'
import { defineConfig } from "@r_masseater/engawa"

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

設定ファイルの検索順:

1. `engawa.config.ts` — CWD から `.git` ルートまで遡って探索
2. `$XDG_CONFIG_HOME/engawa/config.ts`（または `$ENGAWA_HOME`）
3. どちらも無ければデフォルト設定を `~/.config/engawa/config.ts` に作成

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
  provider: "anthropic" | "openai";
  model?: string; // ルーティング先のモデル名
  apiKey?: string; // 環境変数名 or 直接値（sk-...）
  effort?: string; // OpenAI reasoning_effort (config固定)
}

interface EngawaConfig {
  port?: number; // default: 3131
  routes: Record<string, RouteConfig>;
  verbose?: boolean; // default: true
}
```

### ルートマッチング

- 完全一致: `"gpt-5.4"` → model ID `gpt-5.4` にマッチ
- プレフィックス: `"claude-*"` → `claude-` で始まる全モデルにマッチ
- Effort サフィックス: `"o3-high"` → ルート `"o3"` に `effort: "high"` でマッチ
  - レベル: `xhigh`, `high`, `medium`, `low`, `minimal`, `none`
- 最初にマッチしたルートが使われる（順序重要）

### Effort

OpenAI の `reasoning_effort` は以下の優先順で解決:

1. **config の `effort`** — ルート設定で固定
2. **Claude Code の `output_config.effort`** — `/effort` コマンドで設定した値がパススルー

### OpenAI 認証

以下の順で認証情報を探す:

1. ルート設定の `apiKey`
2. `OPENAI_API_KEY` 環境変数
3. Codex CLI の OAuth (`~/.codex/auth.json`)

認証ソースによって使用する API が異なる:

- **API Key** → Chat Completions API (`/v1/chat/completions`)
- **Codex OAuth** → Responses API (`/codex/responses`)

## CLI

```bash
engawa                  # proxy + Claude Code を起動
engawa --no-claude      # proxy のみ
engawa init             # .claude/agents/ を生成
engawa logs             # proxy ログを表示
engawa logs -f          # proxy ログをフォロー
```

