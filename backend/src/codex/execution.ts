import { CodexConnection, CodexConnectionError, type CodexSignal } from "./connection.ts";
import { record } from "./protocol.ts";
import { isAccount, isApiKeyLogin, isEmpty, isThreadResponse, isTurn, isTurnResponse,
  MAX_TEXT_BYTES, textFits, validId, type Turn } from "./executionProtocol.ts";

type Policy = {
  // These are operator configuration, never values accepted from an HTTP body.
  allowPaidCalls: true;
  allowDataTransfer: true;
  executionIsolationReviewed: true;
  model: string;
  maxRunMs: number;
};
type Options = { executable: string; serviceApiKey: string; policy: Policy;
  requestTimeoutMs?: number; interruptGraceMs?: number };
export type ExecutionState = "starting" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "timed_out";
export type ExecutionEvent = { sequence: number; jobId: string; state: ExecutionState };
export type ExecutionResult = {
  jobId: string; threadId: string | null; turnId: string | null;
  status: "completed" | "failed" | "cancelled" | "timed_out";
  remoteStatus: Turn["status"] | "unknown";
  text: string | null; needsReview: boolean; code: string | null;
};
type Task = { jobId: string; text: string; promise: Promise<ExecutionResult>;
  resolve: (result: ExecutionResult) => void; settled: boolean };

export class CodexExecutionError extends Error {
  readonly code: "configuration" | "conflict" | "closed";
  constructor(code: "configuration" | "conflict" | "closed") {
    super(`Codex 실행 요청 오류: ${code}`); this.name = "CodexExecutionError"; this.code = code;
  }
}

/** One opt-in text task per isolated process. Not wired to HTTP, SQLite or UI. */
export class CodexExecution {
  #connection: CodexConnection;
  #key: string | undefined;
  #policy: Policy;
  #graceMs: number;
  #task: Task | undefined;
  #closed = false;
  #threadId: string | null = null;
  #turnId: string | null = null;
  #turnSent = false;
  #cancelled = false;
  #interrupted = false;
  #awaitingTurn = false;
  #buffer: { method: string; params: unknown }[] = [];
  #items = new Map<string, { text: string; phase: unknown }>();
  #events: ExecutionEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #cancelTimer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: () => void;

  constructor(options: Options) {
    const p = options.policy, grace = options.interruptGraceMs ?? 1500;
    if (!p || p.allowPaidCalls !== true || p.allowDataTransfer !== true || p.executionIsolationReviewed !== true
      || typeof p.model !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(p.model)
      || !Number.isSafeInteger(p.maxRunMs) || p.maxRunMs < 50 || p.maxRunMs > 120_000
      || typeof options.serviceApiKey !== "string" || !options.serviceApiKey.trim()
      || Buffer.byteLength(options.serviceApiKey) > 4096 || /[\r\n\0]/.test(options.serviceApiKey)
      || !Number.isSafeInteger(grace) || grace < 50 || grace > 5000) throw new CodexExecutionError("configuration");
    this.#policy = { ...p };
    this.#key = options.serviceApiKey;
    this.#graceMs = grace;
    this.#connection = new CodexConnection({ executable: options.executable, timeoutMs: options.requestTimeoutMs });
    this.#unsubscribe = this.#connection.subscribe((signal) => this.#signal(signal));
  }

  get events(): ExecutionEvent[] { return this.#events.map((event) => ({ ...event })); }

  run(jobId: string, text: string): Promise<ExecutionResult> {
    if (!validId(jobId) || !textFits(text)) return Promise.reject(new CodexExecutionError("configuration"));
    if (this.#task) {
      if (this.#task.jobId === jobId && this.#task.text === text) return this.#task.promise;
      return Promise.reject(new CodexExecutionError("conflict"));
    }
    if (this.#closed) return Promise.reject(new CodexExecutionError("closed"));
    let resolve!: Task["resolve"];
    const promise = new Promise<ExecutionResult>((done) => { resolve = done; });
    this.#task = { jobId, text, promise, resolve, settled: false };
    this.#event("starting");
    this.#timer = setTimeout(() => { void this.#finish("timed_out", "run_timeout"); }, this.#policy.maxRunMs);
    void this.#run(text);
    return promise;
  }

  async #run(text: string): Promise<void> {
    try {
      await this.#connection.start();
      if (this.#task?.settled) return;
      const key = this.#key!;
      this.#key = undefined;
      await this.#connection.request("account/login/start", { type: "apiKey", apiKey: key }, isApiKeyLogin);
      const account = await this.#connection.request("account/read", { refreshToken: false }, isAccount);
      if (account.account?.type !== "apiKey") { await this.#finish("failed", "authentication_required"); return; }
      if (this.#cancelled || this.#task?.settled) return;
      const cwd = this.#connection.workingDirectory;
      const thread = await this.#connection.request("thread/start", {
        model: this.#policy.model, modelProvider: "openai", cwd,
        approvalPolicy: "untrusted", sandbox: "read-only", ephemeral: true,
        config: { web_search: "disabled" },
      }, isThreadResponse);
      if (thread.cwd !== cwd || thread.model !== this.#policy.model) {
        await this.#finish("failed", "policy_mismatch"); return;
      }
      this.#threadId = thread.thread.id;
      if (this.#cancelled || this.#task?.settled) return;
      this.#turnSent = true;
      this.#awaitingTurn = true;
      const response = await this.#connection.request("turn/start", {
        threadId: this.#threadId, input: [{ type: "text", text, text_elements: [] }],
        approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly", networkAccess: false },
      }, isTurnResponse);
      if (this.#task?.settled) return;
      this.#turnId = response.turn.id;
      this.#awaitingTurn = false;
      if (this.#cancelled) this.#interrupt();
      else this.#event("running");
      const buffered = this.#buffer; this.#buffer = [];
      for (const event of buffered) this.#notification(event.method, event.params);
      // A terminal start response is also authoritative; no event is required.
      if (response.turn.status !== "inProgress") this.#terminal(response.turn);
    } catch (error) {
      await this.#finish("failed", error instanceof CodexConnectionError ? error.code : "execution_error");
    }
  }

  cancel(jobId: string): void {
    if (!this.#task || this.#task.jobId !== jobId) throw new CodexExecutionError("conflict");
    if (this.#task.settled || this.#cancelled) return;
    this.#cancelled = true;
    this.#event("cancelling");
    if (!this.#turnSent) { void this.#finish("cancelled", null); return; }
    this.#cancelTimer = setTimeout(() => { void this.#finish("cancelled", "interrupt_unconfirmed"); }, this.#graceMs);
    if (this.#turnId) this.#interrupt();
  }

  #interrupt(): void {
    if (this.#interrupted || this.#task?.settled) return;
    this.#interrupted = true;
    void this.#connection.request("turn/interrupt", { threadId: this.#threadId, turnId: this.#turnId }, isEmpty)
      .catch(() => { void this.#finish("cancelled", "interrupt_unconfirmed"); });
  }

  #signal(signal: CodexSignal): void {
    if (!this.#task || this.#task.settled) return;
    if (signal.type === "closed") { void this.#finish("failed", signal.code); return; }
    if (signal.type === "request_denied") { void this.#finish("failed", "approval_required"); return; }
    if (!["turn/started", "turn/completed", "item/started", "item/completed", "error"].includes(signal.method)) return;
    if (this.#awaitingTurn) {
      if (this.#buffer.length >= 64) { void this.#finish("failed", "event_limit"); return; }
      this.#buffer.push({ method: signal.method, params: signal.params });
    } else this.#notification(signal.method, signal.params);
  }

  #notification(method: string, params: unknown): void {
    if (this.#task?.settled) return;
    if (!record(params) || !validId(params.threadId)) { void this.#finish("failed", "invalid_event"); return; }
    if (params.threadId !== this.#threadId) return; // Never associate another thread's payload.
    if (method.startsWith("turn/")) {
      if (!isTurn(params.turn)) { void this.#finish("failed", "invalid_event"); return; }
      if (params.turn.id !== this.#turnId) { void this.#finish("failed", "turn_mismatch"); return; }
      if (method === "turn/completed") this.#terminal(params.turn);
      else if (params.turn.status !== "inProgress") void this.#finish("failed", "invalid_event");
      return;
    }
    if (params.turnId !== this.#turnId) { void this.#finish("failed", "turn_mismatch"); return; }
    if (method === "error") {
      if (typeof params.willRetry !== "boolean" || !record(params.error) || typeof params.error.message !== "string") {
        void this.#finish("failed", "invalid_event");
      } else if (!params.willRetry) void this.#finish("failed", "turn_error");
      return; // App Server may retry internally, bounded by our wall clock.
    }
    this.#item(params.item, method === "item/completed");
  }

  #item(item: unknown, completed: boolean): void {
    if (this.#task?.settled) return;
    if (!record(item) || !validId(item.id) || typeof item.type !== "string") {
      void this.#finish("failed", "invalid_item"); return;
    }
    if (!["agentMessage", "userMessage", "reasoning", "plan"].includes(item.type)) {
      void this.#finish("failed", "unsupported_item"); return;
    }
    if (item.type !== "agentMessage" || !completed) return;
    if (typeof item.text !== "string" || Buffer.byteLength(item.text) > MAX_TEXT_BYTES
      || !(item.phase === null || (typeof item.phase === "string" && ["commentary", "partial_answer", "final_answer"].includes(item.phase)))) {
      void this.#finish("failed", "invalid_item"); return;
    }
    const previous = this.#items.get(item.id);
    if (previous && (previous.text !== item.text || previous.phase !== item.phase)) {
      void this.#finish("failed", "item_conflict"); return;
    }
    if (!previous && this.#items.size >= 64) { void this.#finish("failed", "item_limit"); return; }
    this.#items.set(item.id, { text: item.text, phase: item.phase });
  }

  #terminal(turn: Turn): void {
    if (this.#task?.settled) return;
    if (turn.status === "inProgress") { void this.#finish("failed", "invalid_completion"); return; }
    if (turn.status === "interrupted" || this.#cancelled) {
      void this.#finish("cancelled", null, turn.status); return;
    }
    if (turn.status !== "completed" || turn.error !== null) {
      void this.#finish("failed", "turn_failed", turn.status); return;
    }
    for (const item of turn.items) this.#item(item, true);
    if (this.#task?.settled) return;
    const text = [...this.#items.values()].filter((item) => item.phase === "final_answer").map((item) => item.text).join("\n\n");
    if (!textFits(text)) { void this.#finish("failed", "invalid_result", turn.status); return; }
    void this.#finish("completed", null, turn.status, text);
  }

  #event(state: ExecutionState): void {
    if (this.#task && this.#events.length < 256) this.#events.push({ sequence: this.#events.length + 1, jobId: this.#task.jobId, state });
  }

  async #finish(status: ExecutionResult["status"], code: string | null,
    remoteStatus: ExecutionResult["remoteStatus"] = "unknown", text: string | null = null): Promise<void> {
    const task = this.#task;
    if (!task || task.settled) return;
    task.settled = true;
    this.#closed = true;
    this.#key = undefined;
    this.#buffer = [];
    this.#items.clear();
    clearTimeout(this.#timer); clearTimeout(this.#cancelTimer);
    try { await this.#connection.close(); }
    catch { status = "failed"; code = "cleanup_failed"; text = null; }
    this.#unsubscribe();
    this.#event(status);
    task.resolve({ jobId: task.jobId, threadId: this.#threadId, turnId: this.#turnId,
      status, remoteStatus, text, needsReview: status === "completed", code });
  }

  async close(): Promise<void> {
    if (this.#task && !this.#task.settled) {
      await this.#finish("cancelled", this.#turnSent ? "interrupt_unconfirmed" : null);
    }
    await this.#connection.close();
    this.#key = undefined; this.#closed = true; this.#unsubscribe();
  }
}
