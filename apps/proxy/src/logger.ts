import { resolve } from "node:path";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { appendFile } from "node:fs/promises";

let verbose = true;
let debug = process.env.ENGAWA_DEBUG === "1";
let logFile: string | null = null;

export function setVerbose(v: boolean) {
  verbose = v;
}

export function setLogFile(path: string | null) {
  logFile = path;
  if (path) {
    mkdirSync(resolve(path, ".."), { recursive: true });
    // Touch the file so tail -f works immediately
    const fd = openSync(path, "a");
    closeSync(fd);
  }
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function write(msg: string) {
  if (logFile) {
    void appendFile(logFile, msg + "\n");
  } else {
    console.log(msg);
  }
}

function writeErr(msg: string) {
  if (logFile) write(msg);
  else console.error(msg);
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

export function logDebug(label: string, data: unknown) {
  if (!debug) return;
  const str = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  write(`[${timestamp()}] DEBUG ${label}\n${str}`);
}
