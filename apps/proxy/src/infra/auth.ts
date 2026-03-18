import { logError } from "../logger.js";

export interface AuthResult {
  headers: Record<string, string>;
  source: "api-key" | "codex-oauth";
}

interface CodexAuthFile {
  OPENAI_API_KEY: string | null;
  tokens?: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id?: string;
  };
  last_refresh?: string;
}

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

function getCodexHomePath(): string {
  return process.env.CODEX_HOME || `${process.env.HOME}/.codex`;
}

function isTokenExpired(accessToken: string): boolean {
  const payload = JSON.parse(atob(accessToken.split(".")[1]!));
  return payload.exp * 1000 < Date.now() + 30_000;
}

async function refreshCodexToken(refreshToken: string): Promise<CodexAuthFile["tokens"] | null> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    logError(`Codex token refresh failed (${res.status})`, await res.text());
    return null;
  }
  const data = (await res.json()) as {
    id_token?: string;
    access_token: string;
    refresh_token?: string;
  };

  const authPath = `${getCodexHomePath()}/auth.json`;
  const file = Bun.file(authPath);
  const existing = (await file.json()) as CodexAuthFile;
  const newTokens = {
    id_token: data.id_token ?? existing.tokens?.id_token ?? "",
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    account_id: existing.tokens?.account_id,
  };
  existing.tokens = newTokens;
  existing.last_refresh = new Date().toISOString();
  await Bun.write(authPath, JSON.stringify(existing, null, 2));

  return newTokens;
}

async function loadCodexAuth(): Promise<AuthResult | null> {
  const codexHome = getCodexHomePath();
  const file = Bun.file(`${codexHome}/auth.json`);
  if (!(await file.exists())) return null;

  const auth = (await file.json()) as CodexAuthFile;

  if (auth.OPENAI_API_KEY) {
    return { headers: { authorization: `Bearer ${auth.OPENAI_API_KEY}` }, source: "api-key" };
  }

  if (!auth.tokens?.access_token) return null;

  let tokens = auth.tokens;

  if (isTokenExpired(tokens.access_token)) {
    if (!tokens.refresh_token) return null;
    const refreshed = await refreshCodexToken(tokens.refresh_token);
    if (!refreshed) return null;
    tokens = refreshed;
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${tokens.access_token}`,
  };
  if (tokens.account_id) {
    headers["chatgpt-account-id"] = tokens.account_id;
  }

  return { headers, source: "codex-oauth" };
}

export async function resolveAuth(apiKey?: string): Promise<AuthResult | null> {
  if (apiKey) {
    const key = apiKey.startsWith("sk-") ? apiKey : process.env[apiKey];
    if (key) return { headers: { authorization: `Bearer ${key}` }, source: "api-key" };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      source: "api-key",
    };
  }
  return loadCodexAuth();
}

export function getBaseUrl(auth: AuthResult): string {
  if (auth.source === "codex-oauth") {
    return "https://chatgpt.com/backend-api/codex";
  }
  return "https://api.openai.com/v1";
}
