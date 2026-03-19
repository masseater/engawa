# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Prerequisites

- **Bun** (runtime and test runner)
- **pnpm** (package manager, version 10.6.5)
- OpenAI credentials: set the OpenAI env var, or authenticate via Codex CLI (`codex login`)

## Commands

```bash
# Install dependencies
pnpm install

# Development
pnpm dev                               # turbo dev (runs all workspaces)
cd apps/proxy && bun run src/index.ts  # run proxy directly

# Build
pnpm build                             # turbo build (all workspaces)
cd apps/proxy && bun run build         # build proxy only

# Test (run from apps/proxy/ directory)
cd apps/proxy && bun test              # run all tests
cd apps/proxy && bun test src/router.test.ts  # run a single test file

# Lint & Format
pnpm lint                              # oxlint via turbo
pnpm format                            # oxfmt (indent: 2, line width: 100)
pnpm format:check                      # check formatting without modifying

# Dead code detection
cd apps/proxy && bun run knip
```

## Architecture

**engawa** is a proxy server that lets Claude Code invoke OpenAI models (GPT, o3) as subagents. It intercepts Anthropic API calls via `ANTHROPIC_BASE_URL`, routes by model ID pattern, and translates between Anthropic and OpenAI wire formats.

### Monorepo Structure (pnpm workspaces + Turborepo)

- **`apps/proxy`** — The main `engawa` npm package (published to npm). Contains CLI, Hono HTTP server, and all conversion logic.
- **`packages/shared`** — Shared TypeScript types (`EngawaConfig`, `RouteConfig`, Anthropic request/response types). Re-exports only.

### Proxy Request Flow

```
Claude Code -> POST /v1/messages -> engawa (Hono)
  1. resolveRoute(): match model ID against config patterns (glob with trailing *)
  2. sanitizeBody(): strip tool_use blocks with empty names + orphan tool_results
  3. dispatch() -> provider handler:
     - anthropic: passthrough (forward headers + body to api.anthropic.com)
     - openai: convert request/response formats
```

### Source Layout (`apps/proxy/src/`)

The code is being refactored into domain/infra layers. Current state:

| File | Layer | Role | Status |
|------|-------|------|--------|
| `domain/convert.ts` | Domain | Pure Anthropic-to-OpenAI conversion (Chat Completions + Responses API) | Canonical |
| `domain/stream.ts` | Domain | SSE stream state machine and chunk processors | Canonical |
| `infra/auth.ts` | Infra | OpenAI auth resolution (env var, config, Codex CLI) | Canonical |
| `providers/openai.ts` | Provider | OpenAI handler — **contains duplicate conversion logic** | Legacy, being extracted |
| `providers/anthropic.ts` | Provider | Anthropic passthrough | Stable |
| `router.ts` | Core | Model ID pattern matching | Stable |
| `sanitize.ts` | Core | Request body cleanup (empty-name tools) | Stable |
| `config.ts` | Core | Config file loading (XDG) | Stable |
| `cli.ts` | Core | CLI entrypoint, agent markdown generation | Stable |
| `index.ts` | Core | Hono app, server bootstrap, route dispatch | Stable |
| `errors.ts` | Core | Anthropic-format error responses | Stable |
| `logger.ts` | Core | Console/file logging with verbose toggle | Stable |
| `types.ts` | Core | Route config and resolved route types | Stable |

### Two OpenAI API Paths

The proxy uses different OpenAI APIs depending on auth source:
- **Standard credentials** (env var or route config) -> Chat Completions API
- **Codex CLI credentials** (auth.json) -> Responses API — always streams, has limited parameter support

### Key Design Decisions

- **Bun runtime** — uses Bun APIs (`Bun.serve`, `Bun.file`, `Bun.spawn`, `Bun.write`). Do not use Node.js equivalents where Bun APIs exist.
- **Streaming conversion** — OpenAI SSE chunks are converted to Anthropic SSE format via a `StreamState` state machine that tracks content blocks, tool calls, and indices
- **Config loading** — searches `$XDG_CONFIG_HOME/engawa/config.ts` (default: `$HOME/.config/engawa/config.ts`), falls back to anthropic-passthrough-only config
- **CLI dual mode** — `engawa` spawns both the proxy and Claude Code process; `engawa --no-claude` runs proxy only
- **Error responses** — always return Anthropic error format (`{ type: "error", error: { type, message } }`) regardless of upstream provider

## Development Guidelines

### DDD Refactoring (in progress)

`providers/openai.ts` still contains legacy conversion logic that duplicates `domain/convert.ts` and `domain/stream.ts`. When writing new code:
- **Pure conversion logic** -> `domain/convert.ts`
- **Stream processing** -> `domain/stream.ts`
- **Auth/external I/O** -> `infra/auth.ts`
- Add new logic to the appropriate domain/infra module; `providers/openai.ts` should only orchestrate calls to those modules

### Testing

Tests live alongside source in `apps/proxy/src/` (`*.test.ts`). Uses `bun:test` framework.

```bash
cd apps/proxy && bun test              # all tests
cd apps/proxy && bun test src/router.test.ts  # single file
```

**Test patterns used in this codebase:**
- `proxy.test.ts` — integration test: starts real proxy + mock OpenAI server on random ports (`port: 0`), intercepts `globalThis.fetch` to redirect API calls to mock
- `router.test.ts` — unit test: tests `resolveRoute()` with in-memory config
- `errors.test.ts` — unit test: tests error type mapping and response format

### Code Style

- Linter: **oxlint** (config: `oxlint.json`) — `eqeqeq` error, `no-console` off
- Formatter: **oxfmt** (config: `.oxfmtrc`) — indent 2, line width 100
- TypeScript strict mode with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`
- Use `type` imports (`import type { ... }`) for type-only imports

## Gotchas

- **`engawa.config.ts` at repo root** is for local development only (imports from `engawa` workspace package). It is ignored by knip.
- **Logging switches to file** when Claude Code is launched (`cli.ts`): during a Claude session, proxy logs go to `$XDG_RUNTIME_DIR/engawa/proxy.log` (or `$HOME/.local/state/engawa/proxy.log`), not stdout.
- **`packages/shared` is ignored by knip** — types are shared but the package has no runtime code.
- **Responses API path** (Codex OAuth) does not support `temperature`, `top_p`, or `max_output_tokens` — these params are silently dropped.
- **Route pattern order matters** — `resolveRoute()` iterates config entries in insertion order and returns the first match.

## CI

GitHub Actions on push to `master`: runs `bun test` + `pnpm lint`, then publishes to npm if `apps/proxy/package.json` version is new.
