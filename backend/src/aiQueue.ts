import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import { validAiConfig, type AiConfig } from "./aiStore.ts";
import { CodexExecution, type ExecutionResult } from "./codex/execution.ts";

export interface AiExecutor {
  run(id: string, text: string): Promise<ExecutionResult>;
  cancel(id: string): void;
  close(): Promise<void>;
}
export type AiRegistration = { config: AiConfig; create: () => AiExecutor };
// Operator-only composition; never deserialize these arguments from an HTTP body.
export function codexAiRegistration(options: ConstructorParameters<typeof CodexExecution>[0], policyId: string): AiRegistration {
  const config: AiConfig = { mode: "codex", model: options.policy.model, policyId };
  if (!validAiConfig(config)) throw new Error("AI 실행 설정이 올바르지 않습니다.");
  const saved = { ...options, policy: { ...options.policy } };
  return { config, create: () => new CodexExecution(saved) };
}
export function createAiQueue(store: Store, registration?: AiRegistration,
  options: { pollMs?: number; timeoutMs?: number } = {}) {
  if (registration && !validAiConfig(registration.config)) throw new Error("AI 실행 설정이 올바르지 않습니다.");
  const config = registration ? { ...registration.config } : undefined;
  const owner = randomUUID(), poll = options.pollMs ?? 250, timeout = options.timeoutMs ?? 130_000;
  if (!Number.isSafeInteger(poll) || poll < 10 || poll > 1000 || !Number.isSafeInteger(timeout) || timeout < 50 || timeout > 180_000)
    throw new Error("AI 큐 시간 설정이 올바르지 않습니다.");
  let leased = false, closed = false, blocked = false, timer: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | undefined;
  type Active = { id: string; executor: AiExecutor; timer: ReturnType<typeof setTimeout>; done: boolean;
    cancelled: boolean; closing?: Promise<void> };
  let active: Active | undefined;
  const failure = (id: string, code: string, status: "failed" | "timed_out" = "failed"): ExecutionResult => ({
    jobId: id, threadId: null, turnId: null, status, code, remoteStatus: "unknown", text: null, needsReview: false,
  });
  function finish(state: Active, value: unknown, record = true, interrupted = false): Promise<void> {
    if (state.done) return state.closing ?? Promise.resolve();
    state.done = true; clearTimeout(state.timer);
    state.closing = (async () => {
      // Stop the local executor before making the next task eligible to start.
      let stopped = true;
      try { await state.executor.close(); }
      catch { blocked = true; stopped = false; value = failure(state.id, "cleanup_failed"); }
      if (record) {
        try { if (!(interrupted && stopped ? store.interruptAi(owner, state.id) : store.finishAi(owner, state.id, value))) leased = false; }
        catch { leased = false; console.error("AI 실행 상태를 저장하지 못했습니다. 소유권을 다시 확인합니다."); }
      }
      if (active === state) active = undefined;
    })();
    return state.closing;
  }
  function tick() {
    if (closed) return;
    if (!leased) {
      if (active) return;
      leased = store.acquireAiLease(owner);
      if (!leased) return;
    } else if (!store.renewAiLease(owner)) {
      leased = false;
      if (active) void finish(active, null, false);
      return;
    }
    if (active) {
      if (!active.done && store.aiStatus(active.id) === "cancelling" && !active.cancelled) {
        active.cancelled = true;
        try { active.executor.cancel(active.id); }
        catch { void finish(active, failure(active.id, "interrupt_unconfirmed")); }
      }
      return;
    }
    if (blocked || !registration || !config) return; // Recovery-only default; never calls a model.
    const claimed = store.claimAi(owner, config);
    if (!claimed) return;
    let executor: AiExecutor;
    try { executor = registration.create(); }
    catch { store.finishAi(owner, claimed.id, failure(claimed.id, "configuration")); return; }
    const state: Active = { id: claimed.id, executor, done: false, cancelled: false,
      timer: setTimeout(() => { void finish(state, failure(state.id, "run_timeout", "timed_out")); }, timeout) };
    active = state;
    try {
      // The durable running transition precedes the sole possible dispatch.
      void executor.run(claimed.id, claimed.input).then(
        (value) => finish(state, value),
        () => finish(state, failure(state.id, "execution_error")),
      ).catch(() => { leased = false; });
    } catch { void finish(state, failure(state.id, "execution_error")); }
  }
  function safeTick() {
    try { tick(); }
    catch {
      leased = false;
      if (active) void finish(active, null, false);
      console.error("AI 큐 상태를 확인하지 못했습니다. 다음 주기에 다시 확인합니다.");
    }
  }
  return {
    config,
    start() {
      if (timer || closed) return;
      safeTick(); timer = setInterval(safeTick, poll); timer.unref();
    },
    stop(): Promise<void> {
      stopping ??= (async () => {
        closed = true; clearInterval(timer);
        if (active) await finish(active, null, true, true);
        if (leased) store.releaseAiLease(owner);
        leased = false;
      })();
      return stopping;
    },
  };
}
