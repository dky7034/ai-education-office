import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";
import {
  CODEX_VERSION, MAX_MESSAGE_BYTES, MAX_SESSION_BYTES,
  initializeParams, isInitializeResult, record, requestId,
} from "./protocol.ts";

export type CodexErrorCode = "configuration" | "version_mismatch" | "launch_failed"
  | "protocol_error" | "remote_error" | "timeout" | "closed" | "transport_error" | "cleanup_failed";

export class CodexConnectionError extends Error {
  readonly code: CodexErrorCode;
  constructor(code: CodexErrorCode) {
    // Never attach raw child stdout/stderr, paths, remote errors or environment.
    super(`Codex 연결 오류: ${code}`);
    this.name = "CodexConnectionError";
    this.code = code;
  }
}

type Options = { executable: string; timeoutMs?: number };
export type CodexMethod = "account/login/start" | "account/read" | "thread/start" | "turn/start" | "turn/interrupt";
export type CodexSignal = { type: "notification"; method: string; params: unknown }
  | { type: "closed"; code: CodexErrorCode } | { type: "request_denied" };
type Pending = {
  validate: (value: unknown) => boolean;
  resolve: (value: unknown) => void;
  reject: (error: CodexConnectionError) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Private transport. Only the backend execution policy may authorize model requests. */
export class CodexConnection {
  #options: Required<Options>;
  #state: "new" | "starting" | "ready" | "closed" = "new";
  #root: string | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #versionProcess: ChildProcess | undefined;
  #exit: Promise<void> | undefined;
  #pending = new Map<number, Pending>();
  #buffer = Buffer.alloc(0);
  #bytes = 0;
  #sentBytes = 0;
  #failure: CodexConnectionError | undefined;
  #closing: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #nextId = 1;
  #listeners = new Set<(signal: CodexSignal) => void>();

  get workingDirectory(): string | undefined { return this.#state === "ready" ? this.#root : undefined; }

  subscribe(listener: (signal: CodexSignal) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #signal(signal: CodexSignal): void {
    for (const listener of this.#listeners) {
      try { listener(signal); } catch { this.#fail("protocol_error"); }
    }
  }

  // Internal backend transport, never exposed as a browser-supplied RPC proxy.
  request<T>(method: CodexMethod, params: unknown, validate: (value: unknown) => value is T): Promise<T> {
    if (this.#state !== "ready") return Promise.reject(this.#failure ?? new CodexConnectionError("closed"));
    if (!["account/login/start", "account/read", "thread/start", "turn/start", "turn/interrupt"].includes(method)
      || this.#pending.size >= 4 || this.#nextId >= 32) return Promise.reject(new CodexConnectionError("configuration"));
    return this.#request(method, params, validate) as Promise<T>;
  }

  #request(method: string, params: unknown, validate: (value: unknown) => boolean): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail("timeout"), this.#options.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, validate });
      try { this.#write({ id, method, params }); }
      catch { this.#fail("transport_error"); }
    });
  }

  constructor(options: Options) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!isAbsolute(options.executable) || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 10 || timeoutMs > 60_000) throw new CodexConnectionError("configuration");
    this.#options = { executable: options.executable, timeoutMs };
  }

  get state() { return this.#state; }

  start(): Promise<void> {
    if (this.#state !== "new") return Promise.reject(new CodexConnectionError("closed"));
    this.#state = "starting";
    this.#starting = this.#start();
    return this.#starting;
  }

  async #start(): Promise<void> {
    try {
      this.#root = await mkdtemp(join(tmpdir(), "ai-office-codex-"));
      const home = join(this.#root, "home"), codexHome = join(this.#root, "codex");
      await mkdir(home, { mode: 0o700 });
      await mkdir(codexHome, { mode: 0o700 });
      // Deliberately do not inherit process.env, HOME auth, API keys, proxies,
      // NODE_OPTIONS, repo config, developer CODEX_HOME or credential helpers.
      const env = { HOME: home, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin", TMPDIR: this.#root };
      if (this.#failure) throw this.#failure;
      const version = await new Promise<string>((resolve, reject) => {
        this.#versionProcess = execFile(this.#options.executable, ["--version"], {
          cwd: this.#root, env, timeout: this.#options.timeoutMs, killSignal: "SIGKILL",
          maxBuffer: 4096, encoding: "utf8",
        }, (error, stdout) => {
          this.#versionProcess = undefined;
          if (error) reject(this.#failure ?? new CodexConnectionError("launch_failed"));
          else resolve(stdout.trim());
        });
      });
      if (this.#state === "closed") throw new CodexConnectionError("closed");
      if (version !== `codex-cli ${CODEX_VERSION}`) throw new CodexConnectionError("version_mismatch");
      const child = spawn(this.#options.executable, ["app-server", "--listen", "stdio://"], {
        cwd: this.#root, env, stdio: ["pipe", "pipe", "pipe"],
      });
      this.#child = child;
      this.#exit = new Promise((resolve) => child.once("close", () => {
        this.#fail("closed");
        resolve();
      }));
      child.once("error", () => this.#fail("launch_failed"));
      child.stdin.on("error", () => this.#fail("transport_error"));
      child.stdout.on("error", () => this.#fail("transport_error"));
      child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
      // Drain without retaining/logging stderr. It can contain private material.
      child.stderr.resume();
      child.stderr.on("error", () => this.#fail("transport_error"));
      const result = await this.#initialize();
      if (!isInitializeResult(result) || result.codexHome !== codexHome) {
        throw new CodexConnectionError("protocol_error");
      }
      // initialize response precedes initialized, as required by App Server.
      this.#write({ method: "initialized" });
      this.#state = "ready";
    } catch (error) {
      const safe = error instanceof CodexConnectionError ? error : new CodexConnectionError("launch_failed");
      this.#fail(safe.code);
      await this.#dispose();
      throw safe;
    }
  }

  #initialize(): Promise<unknown> {
    return this.#request("initialize", initializeParams, isInitializeResult);
  }

  #write(message: unknown): void {
    if (this.#failure || !this.#child || this.#child.stdin.destroyed) {
      throw this.#failure ?? new CodexConnectionError("closed");
    }
    const frame = JSON.stringify(message) + "\n";
    this.#sentBytes += Buffer.byteLength(frame);
    if (this.#sentBytes > MAX_SESSION_BYTES || !this.#child.stdin.write(frame)) {
      this.#fail("transport_error");
      throw this.#failure;
    }
  }

  #receive(chunk: Buffer): void {
    if (this.#failure) return;
    this.#bytes += chunk.length;
    if (this.#bytes > MAX_SESSION_BYTES) { this.#fail("protocol_error"); return; }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let newline: number;
    while ((newline = this.#buffer.indexOf(10)) !== -1) {
      if (newline > MAX_MESSAGE_BYTES) { this.#fail("protocol_error"); return; }
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      try {
        // Decode whole frames so UTF-8 split across pipe chunks remains intact.
        const message: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        this.#message(message);
      } catch { this.#fail("protocol_error"); }
      if (this.#failure) return;
    }
    if (this.#buffer.length > MAX_MESSAGE_BYTES) this.#fail("protocol_error");
  }

  #message(message: unknown): void {
    if (!record(message) || (Object.hasOwn(message, "jsonrpc") && message.jsonrpc !== "2.0")) throw new Error();
    const hasId = Object.hasOwn(message, "id");
    if (Object.hasOwn(message, "method")) {
      if (typeof message.method !== "string" || !message.method || message.method.length > 256
        || Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) throw new Error();
      if (hasId) {
        if (!requestId(message.id)) throw new Error();
        // No approval policy is installed. Decline ALL server requests; never
        // evaluate command/file/credential/tool payloads and never echo params.
        this.#write({ id: message.id, error: { code: -32601, message: "Unsupported client request" } });
        this.#signal({ type: "request_denied" });
      }
      else this.#signal({ type: "notification", method: message.method, params: message.params });
      return;
    }
    if (typeof message.id !== "number" || !hasId || Object.hasOwn(message, "result") === Object.hasOwn(message, "error")) throw new Error();
    const pending = this.#pending.get(message.id);
    if (!pending) throw new Error(); // Unsolicited/duplicate response.
    if (Object.hasOwn(message, "error")) {
      if (!record(message.error) || !Number.isSafeInteger(message.error.code)
        || typeof message.error.message !== "string") throw new Error();
      this.#fail("remote_error");
      return;
    }
    if (!pending.validate(message.result)) throw new Error();
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message.result);
  }

  #fail(code: CodexErrorCode): void {
    if (this.#failure) return;
    this.#failure = new CodexConnectionError(code);
    this.#state = "closed";
    this.#buffer = Buffer.alloc(0);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.#failure);
    }
    this.#pending.clear();
    this.#versionProcess?.kill("SIGKILL");
    this.#child?.kill("SIGTERM");
    this.#signal({ type: "closed", code });
  }

  async #dispose(): Promise<void> {
    const child = this.#child;
    if (child && this.#exit) {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      await this.#exit;
      clearTimeout(killTimer);
    }
    if (this.#root) {
      try { await rm(this.#root, { recursive: true, force: true }); }
      catch { throw new CodexConnectionError("cleanup_failed"); }
    }
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#fail("closed");
      // start() owns cleanup until its asynchronous setup finishes.
      await this.#starting?.catch(() => {});
      await this.#dispose();
    })();
    return this.#closing;
  }
}
