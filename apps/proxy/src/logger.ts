import { resolve } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

let verbose = true;
let logFile: string | null = null;

export function setVerbose(v: boolean) {
  verbose = v;
}

export function setLogFile(path: string) {
  logFile = path;
  mkdirSync(resolve(path, ".."), { recursive: true });
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function write(msg: string) {
  if (logFile) {
    appendFileSync(logFile, msg + "\n");
  } else {
    console.log(msg);
  }
}

function writeErr(msg: string) {
  if (logFile) {
    appendFileSync(logFile, msg + "\n");
  } else {
    console.error(msg);
  }
}

export function logRequest(
  method: string,
  path: string,
  modelId: string,
  provider: string,
  targetModel: string,
) {
  if (!verbose) return;
  write(`[${timestamp()}] ${method} ${path} ${modelId} → ${provider}(${targetModel})`);
}

export function logStream(modelId: string, event: string) {
  if (!verbose) return;
  write(`[${timestamp()}] SSE ${modelId} ${event}`);
}

export function logError(message: string, error?: unknown) {
  writeErr(
    `[${timestamp()}] ERROR ${message} ${error instanceof Error ? error.message : (error ?? "")}`,
  );
}

export function logInfo(message: string) {
  if (!verbose) return;
  write(`[${timestamp()}] ${message}`);
}

export function logBody(label: string, body: Record<string, unknown>) {
  if (!verbose) return;
  const { messages: _m, system: _s, ...rest } = body;
  write(`[${timestamp()}] BODY ${label} ${JSON.stringify(rest)}`);
}
