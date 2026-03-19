---
name: quality-check
description: This skill should be used when the user asks to "run quality check", "run QC", "validate code quality", "run checks", "run all checks", "check code quality", "quality-check", or mentions "品質チェック", "QC". Runs all quality gates (test, typecheck, lint, format, dead code) independently and reports results.
---

# Quality Check

Execute all quality gates for the engawa repository independently, recording results for each step before proceeding to the next. All commands run from the repository root via pnpm + Turborepo.

## Why Independent Execution

The repository provides a `pnpm validate` script that chains all checks with `&&`. However, this stops on the first failure, hiding issues in subsequent steps. To surface all problems at once, run each gate separately as described below.

## Execution Order

Run all steps from the repository root. For each step, record the exit code and any error output before moving to the next.

### Step 1: Test

```bash
pnpm test
```

Run the full test suite via Turborepo (uses vitest). Tests live alongside source files in `apps/proxy/src/` as `*.test.ts` files. On failure, note the test name, assertion message, and file location.

**Current test files:**

- `proxy.test.ts` — Integration test (real proxy + mock OpenAI server)
- `router.test.ts` — Unit test for route pattern matching
- `errors.test.ts` — Unit test for error type mapping

### Step 2: Type Check

```bash
pnpm typecheck
```

Run TypeScript type checking via Turborepo. The TypeScript configuration (`tsconfig.json`) enforces:

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noImplicitReturns: true`
- `verbatimModuleSyntax: true`

On failure, record each error's file path, line number, and diagnostic message.

### Step 3: Lint

```bash
pnpm lint
```

Run oxlint via Turborepo on `apps/proxy/src/`. The linter configuration (`oxlint.json`) applies these rules:

- `eqeqeq` = **error** — strict equality required
- `no-unused-vars` = **warn**
- `no-console` = **off**

On failure, record each violation's rule, file path, and line number.

### Step 4: Format

```bash
pnpm format:check
```

Run `oxfmt --check .` across the entire monorepo. The formatter configuration (`.oxfmtrc`) enforces:

- Indent width: 2 spaces
- Line width: 100 characters

On failure, record the list of files that need reformatting. To auto-fix, run `pnpm format`.

### Step 5: Dead Code Detection

```bash
pnpm --filter engawa knip
```

Run knip to detect unused exports, dependencies, and files. The knip configuration (`knip.json`) has these known exclusions:

| Exclusion                   | Reason                                            |
| --------------------------- | ------------------------------------------------- |
| `engawa.config.ts`          | Local development config, not part of the package |
| `packages/shared` workspace | Type-only package with no runtime code            |
| `oxfmt` binary              | Dev tool, not a runtime dependency                |
| `engawa` dependency         | Workspace self-reference                          |

On failure, record each finding (unused export, file, or dependency) with its location.

## Handling Failures

After completing all five steps, if any step failed:

1. List all failures grouped by step
2. For format violations, suggest running `pnpm format` to auto-fix
3. For lint warnings (`no-unused-vars`), note these are warnings, not errors — evaluate whether they indicate dead code or intentional patterns
4. For knip findings, cross-reference against the known exclusions table above before reporting

## Quick Reference

| Step       | Command                     | Tool   | Scope                      |
| ---------- | --------------------------- | ------ | -------------------------- |
| Test       | `pnpm test`                 | vitest | `apps/proxy/src/*.test.ts` |
| Type Check | `pnpm typecheck`            | tsgo   | `apps/proxy/src/**/*.ts`   |
| Lint       | `pnpm lint`                 | oxlint | `apps/proxy/src/`          |
| Format     | `pnpm format:check`         | oxfmt  | Entire monorepo            |
| Dead Code  | `pnpm --filter engawa knip` | knip   | `apps/proxy/` workspace    |
