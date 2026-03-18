const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
} as const;

let verbose = true;

export function setVerbose(v: boolean) {
  verbose = v;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export function logRequest(
  method: string,
  path: string,
  modelId: string,
  provider: string,
  targetModel: string,
) {
  if (!verbose) return;
  console.log(
    `${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.cyan}${method}${COLORS.reset} ${path} ` +
      `${COLORS.yellow}${modelId}${COLORS.reset} → ${COLORS.green}${provider}${COLORS.reset}` +
      `${COLORS.dim}(${targetModel})${COLORS.reset}`,
  );
}

export function logStream(modelId: string, event: string) {
  if (!verbose) return;
  console.log(
    `${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.magenta}SSE${COLORS.reset} ` +
      `${COLORS.dim}${modelId}${COLORS.reset} ${event}`,
  );
}

export function logError(message: string, error?: unknown) {
  console.error(
    `${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.red}ERROR${COLORS.reset} ${message}`,
    error instanceof Error ? error.message : (error ?? ""),
  );
}

export function logInfo(message: string) {
  if (!verbose) return;
  console.log(
    `${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.green}INFO${COLORS.reset} ${message}`,
  );
}

export function logBody(label: string, body: Record<string, unknown>) {
  if (!verbose) return;
  const { messages: _m, system: _s, ...rest } = body;
  console.log(
    `${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.yellow}BODY${COLORS.reset} ${label}`,
    JSON.stringify(rest, null, 2),
  );
}
