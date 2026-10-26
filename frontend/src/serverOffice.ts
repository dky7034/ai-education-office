import type { AiOfficeView } from "./aiActivity";
import { aiActivityLabel } from "./aiActivity";
import { createStaff, type Staff } from "./simulation";
export interface OfficeRun {
  runId: string;
  jobId: string;
  jobTitle: string;
  fileId: string;
  filename: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  review: "pending" | "approved" | "rejected" | "summary_only" | null;
  revision: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface ServerOffice {
  executionMode: "quantitative_summary";
  aiConnected: false;
  totals: {
    jobs: number;
    queued: number;
    running: number;
    latestRuns: number;
    completed: number;
    failed: number;
    cancelled: number;
    reviewPending: number;
    approved: number;
    rejected: number;
    summaryOnly: number;
  };
  focus: OfficeRun | null;
  recent: OfficeRun[];
}
export interface ServerOfficeView {
  accountId: string;
  ai?: AiOfficeView;
  data: ServerOffice | null;
  error: string;
  verifiedAt: string | null;
  connection: string;
}
export const runLabel = (run: OfficeRun) =>
  run.status === "completed"
    ? {
        pending: "검토 대기",
        approved: "승인 기록",
        rejected: "반려 기록",
        summary_only: "요약만 보관",
      }[run.review ?? "summary_only"]
    : {
        queued: "집계 대기",
        running: "집계 실행 중",
        failed: "집계 실패",
        cancelled: "집계 취소",
      }[run.status];
export const officeStale = (view: ServerOfficeView) =>
  !view.data || !!view.error || view.connection !== "자동 갱신 연결됨";
function quantitativeStaff(view: ServerOfficeView): Staff[] {
  const people = createStaff();
  for (const person of people) person.task = "연결된 실제 실행이 없습니다.";
  const analyst = people.find((p) => p.id === "analyst")!,
    lead = people.find((p) => p.id === "lead")!;
  const data = view.data;
  if (officeStale(view)) {
    analyst.displayStatus = "상태 확인 필요";
    analyst.task =
      "마지막 확인 기록입니다. 현재 실행 상태는 연결 복구 후 확인합니다.";
    return people;
  }
  if (!data?.focus) {
    analyst.task = data?.totals.jobs
      ? "요청은 보관 중이며 접수한 집계가 없습니다."
      : "접수한 집계가 없습니다.";
    return people;
  }
  const run = data.focus;
  analyst.displayStatus = runLabel(run);
  analyst.task = `${run.jobTitle} · ${run.filename} · 선택 버전 ${run.revision}`;
  analyst.history = data.recent.map((r) => `${r.jobTitle} · ${runLabel(r)}`);
  if (run.status === "running") {
    analyst.status = "작업 실행 중";
    analyst.target = analyst.desk;
  } else if (run.status === "failed") analyst.status = "오류 발생";
  else if (run.status === "completed") {
    analyst.status = run.review === "pending" ? "승인 대기" : "작업 완료";
    analyst.target =
      run.review === "pending" ? { x: 468, y: 384 } : analyst.desk;
  }
  if (data.totals.reviewPending) {
    lead.status = "승인 대기";
    lead.displayStatus = `검토 대기 ${data.totals.reviewPending}건`;
    lead.task =
      "사용자의 검토를 기다립니다. 캐릭터가 승인하거나 반려하지 않습니다.";
    lead.target = lead.desk;
  }
  return people;
}
export const aiOfficeStale = (view: ServerOfficeView) => !view.ai?.data || !!view.ai.error || view.connection !== "자동 갱신 연결됨";
export function serverStaff(view: ServerOfficeView): Staff[] {
  const people = quantitativeStaff(view);
  if (!view.ai) return people;
  const writer = people.find((p) => p.id === "writer")!, lead = people.find((p) => p.id === "lead")!;
  if (aiOfficeStale(view)) { writer.displayStatus = "AI 기록 확인 필요"; writer.task = "연결 복구 전에는 AI 작업 상태를 표시하지 않습니다."; return people; }
  const ai = view.ai.data!, run = ai.focus;
  writer.task = "접수한 AI 텍스트 초안이 없습니다.";
  if (run) {
    writer.displayStatus = `${run.mode === "synthetic" ? "합성 기록" : "Codex 기록"} · ${aiActivityLabel(run)}`;
    writer.task = `${run.jobTitle} · ${writer.displayStatus}${run.mode === "synthetic" ? " · 실제 AI 호출 아님" : ""}`;
    writer.history = ai.recent.map((r) => `${r.mode === "synthetic" ? "합성" : "Codex"} · ${r.jobTitle} · ${aiActivityLabel(r)}`);
    if (run.mode === "codex") {
      if (run.status === "running") { writer.status = "문서 작성 중"; writer.target = writer.desk; }
      else if (run.status === "completed") {
        writer.status = run.review === "pending" ? "승인 대기" : "작업 완료";
        writer.target = run.review === "pending" ? { x: 468, y: 384 } : writer.desk;
      } else if (["failed", "timed_out", "interrupted"].includes(run.status)) writer.status = "오류 발생";
    }
  }
  if (ai.totals.reviewPending) {
    const quantitative = officeStale(view) ? 0 : view.data!.totals.reviewPending;
    lead.status = "승인 대기"; lead.target = lead.desk;
    lead.displayStatus = quantitative ? `집계 검토 ${quantitative}건 · AI 초안 검토 ${ai.totals.reviewPending}건` : `AI 초안 검토 대기 ${ai.totals.reviewPending}건`;
    lead.task = "사용자 검토 대기 기록입니다. 합성 기록도 포함하며 캐릭터가 승인하지 않습니다.";
  }
  return people;
}
export function resultLink(run: OfficeRun) {
  const params = new URLSearchParams({
    job: run.jobId,
    file: run.fileId,
    run: run.runId,
  });
  return "/?" + params.toString();
}

export function parseServerOffice(value: unknown): ServerOffice {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const count = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const date = (v: unknown) =>
    typeof v === "string" && Number.isFinite(Date.parse(v));
  const record = (v: unknown) => {
    if (!object(v)) return false;
    return (
      ["runId", "jobId", "jobTitle", "fileId", "filename"].every(
        (key) => typeof v[key] === "string",
      ) &&
      ["queued", "running", "completed", "failed", "cancelled"].includes(
        String(v.status),
      ) &&
      (v.review === null ||
        ["pending", "approved", "rejected", "summary_only"].includes(
          String(v.review),
        )) &&
      count(v.revision) &&
      (v.revision as number) > 0 &&
      date(v.createdAt) &&
      (v.startedAt === null || date(v.startedAt)) &&
      (v.finishedAt === null || date(v.finishedAt))
    );
  };
  if (
    !object(value) ||
    value.executionMode !== "quantitative_summary" ||
    value.aiConnected !== false ||
    !object(value.totals) ||
    ![
      "jobs",
      "queued",
      "running",
      "latestRuns",
      "completed",
      "failed",
      "cancelled",
      "reviewPending",
      "approved",
      "rejected",
      "summaryOnly",
    ].every((key) => count((value.totals as Record<string, unknown>)[key])) ||
    !(value.focus === null || record(value.focus)) ||
    !Array.isArray(value.recent) ||
    value.recent.length > 5 ||
    !value.recent.every(record)
  )
    throw new Error(
      "서버 집계 현황 응답 형식을 확인하지 못했습니다. 마지막 기록을 유지합니다.",
    );
  return value as unknown as ServerOffice;
}
