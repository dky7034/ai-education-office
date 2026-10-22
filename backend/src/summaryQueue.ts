import {
  outputPaths,
  publishArtifactSet,
  discardOutputs,
  sweepOutputs,
  type RunArtifact,
} from "./runArtifacts.ts";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
export function createSummaryQueue(
  store: Store,
  options: { pollMs?: number; timeoutMs?: number; workerUrl?: URL } = {},
) {
  const owner = randomUUID(),
    poll = options.pollMs ?? 250,
    timeout = options.timeoutMs ?? 15000;
  let lastSweep = 0;
  let timer: ReturnType<typeof setInterval> | null = null,
    leased = false,
    closed = false;
  type Active = {
    id: string;
    worker: Worker;
    timeout: ReturnType<typeof setTimeout>;
    done: boolean;
    paths: { stage: string; final: string };
    terminating?: Promise<void>;
  };
  let active: Active | null = null;
  function finish(
    state: Active,
    result: unknown,
    error: string | null,
    record = true,
    artifacts: RunArtifact[] = [],
  ) {
    if (state.done) return state.terminating ?? Promise.resolve();
    state.done = true;
    clearTimeout(state.timeout);
    if (record) {
      try {
        if (!error && store.summaryRunStatus(state.id) === "running")
          publishArtifactSet(state.paths.stage, state.paths.final, artifacts);
        store.finishSummaryRun(owner, state.id, result, error, artifacts);
      } catch {
        try {
          store.finishSummaryRun(
            owner,
            state.id,
            null,
            "집계 결과 파일을 보관하지 못했습니다. 보관 경로와 저장 공간을 확인해 주세요.",
          );
        } catch {
          leased = false;
        }
        console.error(
          "집계 상태를 저장하지 못했습니다. 큐 소유권을 다시 확인합니다.",
        );
      }
    }
    state.terminating = state.worker
      .terminate()
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        let keepFinal = true;
        try {
          keepFinal = store.summaryRunStatus(state.id) === "completed";
        } catch {}
        discardOutputs(state.paths.stage, state.paths.final, keepFinal);
        if (active === state) active = null;
      });
    return state.terminating;
  }
  function tick() {
    if (closed) return;
    if (!leased) {
      if (active) return;
      leased = store.acquireSummaryLease(owner);
      if (!leased) return;
      lastSweep = 0;
    } else if (!store.renewSummaryLease(owner)) {
      leased = false;
      if (active) void finish(active, null, null, false);
      return;
    }
    if (Date.now() - lastSweep >= 30000) {
      lastSweep = Date.now();
      try {
        sweepOutputs(
          store.outputRoot,
          (id) => store.summaryRunStatus(id),
          active?.paths.stage,
        );
      } catch {
        console.error(
          "집계 보관 경로를 정리하지 못했습니다. 저장 공간과 경로를 확인해 주세요.",
        );
      }
    }
    if (active) {
      if (!active.done && store.summaryRunStatus(active.id) !== "running")
        void finish(active, null, null, false);
      return;
    }
    const claimed = store.claimSummaryRun(owner);
    if (!claimed) return;
    const { run, selection, accountId, settingsCurrent } = claimed;
    if (!settingsCurrent) {
      store.finishSummaryRun(
        owner,
        run.id,
        null,
        "실행 전에 원본·선택 버전이 변경되었습니다. 새 작업으로 접수해 주세요.",
      );
      return;
    }
    const file = store
      .attachments(accountId, run.jobId)
      ?.find((f) => f.id === run.fileId);
    if (!file) {
      store.finishSummaryRun(
        owner,
        run.id,
        null,
        "첨부 원본을 찾지 못했습니다.",
      );
      return;
    }
    const paths = outputPaths(store.outputRoot, run.id, randomUUID());
    try {
      const worker = new Worker(
        options.workerUrl ??
          new URL(
            import.meta.url.endsWith(".ts")
              ? "./summaryWorker.ts"
              : "./summaryWorker.js",
            import.meta.url,
          ),
        {
          workerData: {
            path: store.attachmentPath(run.jobId, run.fileId),
            size: file.size,
            hash: run.sourceHash,
            format: file.format,
            selection,
            stage: paths.stage,
            runId: run.id,
            jobId: run.jobId,
            fileId: run.fileId,
            filename: file.name,
          },
          execArgv: [],
          resourceLimits: {
            maxOldGenerationSizeMb: 128,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 4,
          },
        },
      );
      const state: Active = {
        id: run.id,
        worker,
        paths,
        done: false,
        timeout: setTimeout(() => {
          void finish(state, null, "집계 실행 제한 시간을 초과했습니다.");
        }, timeout),
      };
      active = state;
      worker.on("message", (message) => {
        // Node's --watch also relays dependency notifications over this port.
        // Only application result messages may finish a run.
        if (state.done || closed || typeof message?.ok !== "boolean") return;
        if (message.ok === true)
          void finish(state, message.summary, null, true, message.artifacts);
        else
          void finish(
            state,
            null,
            typeof message?.error === "string"
              ? message.error
              : "집계를 완료하지 못했습니다.",
          );
      });
      worker.on("error", () => {
        if (!state.done)
          void finish(
            state,
            null,
            "집계 실행 중 오류 또는 메모리 제한으로 종료되었습니다.",
          );
      });
      worker.on("exit", () => {
        if (!state.done)
          void finish(state, null, "집계 실행이 결과 없이 종료되었습니다.");
      });
    } catch {
      store.finishSummaryRun(
        owner,
        run.id,
        null,
        "집계 실행을 시작하지 못했습니다.",
      );
    }
  }
  function safeTick() {
    try {
      tick();
    } catch {
      leased = false;
      if (active) void finish(active, null, null, false);
      console.error(
        "집계 큐를 확인하지 못했습니다. 다음 주기에 다시 확인합니다.",
      );
    }
  }
  return {
    start() {
      if (timer || closed) return;
      safeTick();
      timer = setInterval(safeTick, poll);
      timer.unref();
    },
    async stop() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (active)
        await finish(
          active,
          null,
          "서버가 중단되어 집계가 종료되었습니다. 새 작업으로 접수해 주세요.",
        );
      if (leased) store.releaseSummaryLease(owner);
      leased = false;
    },
  };
}
