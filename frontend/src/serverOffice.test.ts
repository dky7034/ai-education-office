import { expect, it } from "vitest";
import {
  serverStaff,
  parseServerOffice,
  resultLink,
  type ServerOfficeView,
  type OfficeRun,
} from "./serverOffice";
const run: OfficeRun = {
  runId: "run-id",
  jobId: "job-id",
  jobTitle: "합성 업무",
  fileId: "file-id",
  filename: "합성.csv",
  status: "running",
  review: null,
  revision: 1,
  createdAt: "2026-10-22T00:00:00Z",
  startedAt: null,
  finishedAt: null,
};
const view: ServerOfficeView = {
  accountId: "account",
  connection: "자동 갱신 연결됨",
  error: "",
  verifiedAt: "2026-10-22T00:00:00Z",
  data: {
    executionMode: "quantitative_summary",
    aiConnected: false,
    totals: {
      jobs: 1,
      queued: 0,
      running: 1,
      latestRuns: 1,
      completed: 0,
      failed: 0,
      cancelled: 0,
      reviewPending: 0,
      approved: 0,
      rejected: 0,
      summaryOnly: 0,
    },
    focus: run,
    recent: [run],
  },
};
it("실제 정량 집계는 분석가에 표시하고 다른 역할이나 시연 상태를 만들지 않는다", () => {
  const people = serverStaff(view),
    analyst = people.find((p) => p.id === "analyst")!;
  expect(analyst.target).toEqual(analyst.desk);
  expect(analyst.displayStatus).toBe("집계 실행 중");
  expect(
    people
      .filter((p) => p.id !== "analyst")
      .every((p) => p.status === "대기 중"),
  ).toBe(true);
  expect(view.data?.focus?.status).toBe("running");
});
it("검토 대기는 사용자 확인이며 확정 기록과 실패/취소를 구분한다", () => {
  const data = view.data!;
  const people = serverStaff({
    ...view,
    data: {
      ...data,
      totals: { ...data.totals, reviewPending: 1 },
      focus: { ...run, status: "completed", review: "pending" },
    },
  });
  expect(people.find((p) => p.id === "lead")!.displayStatus).toBe(
    "검토 대기 1건",
  );
  expect(people.find((p) => p.id === "analyst")!.target).toEqual({
    x: 468,
    y: 384,
  });
  for (const [status, review, label] of [
    ["completed", "approved", "승인 기록"],
    ["completed", "rejected", "반려 기록"],
    ["completed", "summary_only", "요약만 보관"],
    ["failed", null, "집계 실패"],
    ["cancelled", null, "집계 취소"],
  ] as const)
    expect(
      serverStaff({
        ...view,
        data: { ...data, focus: { ...run, status, review } },
      }).find((p) => p.id === "analyst")!.displayStatus,
    ).toBe(label);
});
it("단절·재생 중·조회 실패에는 이전 상태로 계속 작업하는 것처럼 표시하지 않는다", () => {
  for (const state of [
    { ...view, connection: "자동 갱신 재연결 중" },
    { ...view, connection: "누락 변경 복구 중" },
    { ...view, error: "합성 연결 실패" },
  ]) {
    const analyst = serverStaff(state).find((p) => p.id === "analyst")!;
    expect(analyst.status).toBe("대기 중");
    expect(analyst.displayStatus).toBe("상태 확인 필요");
    expect(analyst.target).toEqual(analyst.home);
  }
  expect(
    serverStaff({ ...view, data: null }).find((p) => p.id === "analyst")!
      .displayStatus,
  ).toBe("상태 확인 필요");
});
it("업무 보관만으로 실행을 시작하지 않으며 결과 링크에 정확한 실행 ID를 연결한다", () => {
  expect(
    serverStaff({
      ...view,
      data: { ...view.data!, focus: null, recent: [] },
    }).every((p) => p.status === "대기 중"),
  ).toBe(true);
  const params = new URL(resultLink(run), "http://localhost").searchParams;
  expect(Object.fromEntries(params)).toEqual({
    job: run.jobId,
    file: run.fileId,
    run: run.runId,
  });
});

it("잘못된 응답·상태·AI 표시·카운터는 화면에 적용하지 않는다", () => {
  expect(parseServerOffice(view.data)).toBe(view.data);
  for (const invalid of [
    null,
    {},
    { ...view.data, totals: null },
    { ...view.data, aiConnected: true },
    { ...view.data, totals: { ...view.data!.totals, running: -1 } },
    { ...view.data, focus: { ...run, status: "invented" } },
    { ...view.data, focus: { ...run, revision: 1.5 } },
    { ...view.data, recent: [null] },
  ])
    expect(() => parseServerOffice(invalid)).toThrow("응답 형식");
});
