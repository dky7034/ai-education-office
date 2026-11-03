import { codexAiRegistration } from "./aiQueue.ts";
import { loadServiceConfig, readPrivateConfigFile } from "./codex/serviceConfig.ts";
import { record } from "./codex/protocol.ts";
import { validId } from "./codex/executionProtocol.ts";

export class AiRuntimeError extends Error {
  constructor() { super("AI 운영 설정을 확인하세요. 서버는 시작하지 않았습니다. 비공개 파일·제품 설정·호출 검증·허용 계정을 확인하세요."); }
}

/** Explicit operator opt-in only. Loading this configuration never starts a child or calls a model. */
export async function loadAiRuntime(path: string | undefined) {
  if (path === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(await readPrivateConfigFile(path, 8192, "config_file"));
    const keys = ["version", "enableDispatch", "serviceCallVerified", "serviceConfigFile", "policyId", "allowedAccountIds"];
    if (!record(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))
      || value.version !== 1 || value.enableDispatch !== true || value.serviceCallVerified !== true
      || !validId(value.policyId) || typeof value.serviceConfigFile !== "string"
      || !Array.isArray(value.allowedAccountIds) || value.allowedAccountIds.length < 1 || value.allowedAccountIds.length > 20
      || !value.allowedAccountIds.every((id): id is string => typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))
      || new Set(value.allowedAccountIds).size !== value.allowedAccountIds.length) throw new AiRuntimeError();
    const options = await loadServiceConfig(value.serviceConfigFile);
    return { registration: codexAiRegistration(options, value.policyId), allowedAccountIds: [...value.allowedAccountIds] as readonly string[] };
  } catch { throw new AiRuntimeError(); }
}
