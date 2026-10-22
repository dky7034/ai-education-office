// Narrow v2 execution contract from codex-cli 0.163.0 generate-ts.
import { record } from "./protocol.ts";
export const MAX_TEXT_BYTES = 16 * 1024;
export const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const textFits = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= MAX_TEXT_BYTES;
export const isApiKeyLogin = (value: unknown): value is { type: "apiKey" } => record(value) && value.type === "apiKey";
export const isAccount = (value: unknown): value is { account: null | { type: string }; requiresOpenaiAuth: boolean } =>
  record(value) && typeof value.requiresOpenaiAuth === "boolean"
  && (value.account === null || (record(value.account) && typeof value.account.type === "string" && ["apiKey", "chatgpt", "amazonBedrock"].includes(value.account.type)));
export const isEmpty = (value: unknown): value is Record<string, never> => record(value) && Object.keys(value).length === 0;
export type Turn = { id: string; status: "inProgress" | "completed" | "failed" | "interrupted";
  items: unknown[]; itemsView: "notLoaded" | "summary" | "full"; error: Record<string, unknown> | null };
export const isTurn = (value: unknown): value is Turn => record(value) && validId(value.id)
  && typeof value.status === "string" && ["inProgress", "completed", "failed", "interrupted"].includes(value.status)
  && Array.isArray(value.items) && value.items.length <= 64
  && typeof value.itemsView === "string" && ["notLoaded", "summary", "full"].includes(value.itemsView)
  && (value.error === null || (record(value.error) && typeof value.error.message === "string"));
export const isTurnResponse = (value: unknown): value is { turn: Turn } => record(value) && isTurn(value.turn);
export type ThreadResponse = { thread: { id: string; ephemeral: true }; model: string; modelProvider: string;
  cwd: string; approvalPolicy: "untrusted"; sandbox: { type: "readOnly"; networkAccess: false } };
export const isThreadResponse = (value: unknown): value is ThreadResponse => record(value)
  && record(value.thread) && validId(value.thread.id) && value.thread.ephemeral === true
  && typeof value.model === "string" && value.modelProvider === "openai" && typeof value.cwd === "string"
  && value.approvalPolicy === "untrusted" && record(value.sandbox)
  && value.sandbox.type === "readOnly" && value.sandbox.networkAccess === false;
