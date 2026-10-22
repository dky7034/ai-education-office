// Contract subset checked against codex app-server generate-ts, CLI 0.163.0.
// Upstream: openai/codex, rust-v0.163.0/codex-rs/app-server/README.md
export const CODEX_VERSION = "0.163.0";
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_SESSION_BYTES = 1024 * 1024;

export const initializeParams = {
  clientInfo: { name: "ai_education_office", title: "AI 교육운영 오피스", version: "0.3.0" },
  capabilities: {
    experimentalApi: false,
    requestAttestation: false,
    explicitGatewayOauth: true,
  },
} as const;

export type InitializeResult = {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
};

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Permit additive response fields, but never coerce required fields.
export function isInitializeResult(value: unknown): value is InitializeResult {
  return record(value) && ["userAgent", "codexHome", "platformFamily", "platformOs"]
    .every((key) => typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 4096);
}

export function requestId(value: unknown): value is string | number {
  return (typeof value === "string" && value.length > 0 && value.length <= 256)
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}
