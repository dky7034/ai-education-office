import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { CodexExecution } from "./execution.ts";
import { record } from "./protocol.ts";

export class ServiceConfigError extends Error {
  readonly code: "config_file" | "config_schema" | "policy_required" | "key_file" | "key_format" | "executable";
  constructor(code: ServiceConfigError["code"]) {
    super(`AI 서비스 설정 오류: ${code}`);
    this.code = code;
  }
}
export type ServiceConfig = ConstructorParameters<typeof CodexExecution>[0];

// Read only an operator-owned private regular file. Never put file paths or contents in errors.
async function privateFile(path: unknown, limit: number, code: "config_file" | "key_file") {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new ServiceConfigError(code);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.geteuid?.() || (info.mode & 0o7777) !== 0o600 || info.nlink !== 1
      || info.size < 1 || info.size > limit) throw new Error();
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > limit) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } catch { throw new ServiceConfigError(code); }
  finally { await file?.close(); }
}

/** Offline validation only: no child process, provider request, DB or inherited auth. */
export async function loadServiceConfig(path: string): Promise<ServiceConfig> {
  const json = await privateFile(path, 8192, "config_file");
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new ServiceConfigError("config_schema"); }
  const keys = ["version", "executable", "serviceApiKeyFile", "model", "maxRunMs", "allowPaidCalls", "allowDataTransfer", "executionIsolationReviewed"];
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))
    || value.version !== 1 || typeof value.executable !== "string" || !isAbsolute(value.executable) || value.executable.includes("\0")
    || typeof value.model !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(value.model)
    || !Number.isSafeInteger(value.maxRunMs) || (value.maxRunMs as number) < 50 || (value.maxRunMs as number) > 120_000)
    throw new ServiceConfigError("config_schema");
  if (value.allowPaidCalls !== true || value.allowDataTransfer !== true || value.executionIsolationReviewed !== true)
    throw new ServiceConfigError("policy_required");
  try {
    if (!(await stat(value.executable)).isFile()) throw new Error();
    await access(value.executable, constants.X_OK);
  } catch { throw new ServiceConfigError("executable"); }
  const serviceApiKey = (await privateFile(value.serviceApiKeyFile, 4098, "key_file")).replace(/\r?\n$/, "");
  if (!serviceApiKey || serviceApiKey !== serviceApiKey.trim() || Buffer.byteLength(serviceApiKey) > 4096 || /[\x00-\x20\x7f]/.test(serviceApiKey))
    throw new ServiceConfigError("key_format");
  return { executable: value.executable, serviceApiKey, policy: {
    model: value.model, maxRunMs: value.maxRunMs as number,
    allowPaidCalls: true, allowDataTransfer: true, executionIsolationReviewed: true,
  } };
}
