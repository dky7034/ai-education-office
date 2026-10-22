import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { aiOutcome, parseAiRun, parseAiPage, parseAiDetail, parseAiText, parseAiAdmission, parseAiCancel, type AiRun } from "./aiProtocol";
const job = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const time = "2026-10-22T01:00:00.000Z";
const run: AiRun = { id, jobId: job, status: "completed", mode: "synthetic", model: "synthetic-model", code: null,
  remoteStatus: "completed", threadId: "thread", turnId: "turn", createdAt: time, startedAt: time, finishedAt: time };
const page = { runs: [run], page: { total: 1, limit: 20, offset: 0, hasMore: false }, capability: { configured: false, mode: "disabled" } };
const events = ["queued", "running", "completed"].map((status) => ({ status, createdAt: time }));
const result = (text: string) => ({ text, sha256: createHash("sha256").update(text).digest("hex"), needsReview: true, mode: "synthetic" });
describe("AI 실행 응답 계약", () => {
  it("설정 비활성과 합성 보관 기록을 독립적으로 수락한다", () => {
    expect(parseAiPage(page, job, 0).runs[0].mode).toBe("synthetic");
    expect(parseAiDetail({ run, events }, job, id).run.status).toBe("completed");
    expect(parseAiPage({ ...page, runs: [], page: { total: 1, limit: 20, offset: 20, hasMore: false } }, job, 20).runs).toEqual([]);
  });
  it("다른 업무·완료 오류·잘못된 유형·시간은 적용하지 않는다", () => {
    for (const change of [{ jobId: id }, { mode: ["codex"] }, { status: "approved" }, { code: "error" },
      { remoteStatus: ["completed"] }, { finishedAt: null }, { threadId: null }, { createdAt: "bad" }])
      expect(() => parseAiRun({ ...run, ...change }, job)).toThrow();
  });
  it("중복 실행·잘못된 페이지·설정 응답으로 접수를 활성화하지 않는다", () => {
    for (const value of [null, { ...page, runs: [run, run] }, { ...page, page: { ...page.page, total: -1 } },
      { ...page, page: { ...page.page, hasMore: true } }, { ...page, capability: { configured: true, mode: "disabled" } },
      { ...page, capability: { configured: true, mode: ["codex"] } }]) expect(() => parseAiPage(value, job, 0)).toThrow();
  });
  it("상세 실행 ID·순서·상태 전이와 최근 상태를 확인한다", () => {
    for (const value of [{ run, events: [] }, { run: { ...run, id: job }, events }, { run, events: events.slice(0, 2) },
      { run, events: [events[0], events[2]] }, { run, events: [...events, events[2]] }])
      expect(() => parseAiDetail(value, job, id)).toThrow();
  });
  it("검수 필요 플래그·출처·UTF-8 한도·원문 해시를 확인한다", async () => {
    const text = "합성 <script>문자</script>";
    expect((await parseAiText(result(text), run)).text).toBe(text);
    for (const value of [{ ...result(text), mode: "codex" }, { ...result(text), needsReview: false },
      { ...result(text), text: "changed" }, result(" "), result("가".repeat(5462))])
      await expect(parseAiText(value, run)).rejects.toThrow();
  });
  it("접수·취소 응답의 실행과 형태가 일치해야 한다", () => {
    expect(parseAiAdmission({ run, replayed: true }, job).run.id).toBe(id);
    for (const value of [null, [], { run }, { run, replayed: "yes" }]) expect(() => parseAiAdmission(value, job)).toThrow();
    expect(() => parseAiCancel({ run }, job, job)).toThrow();
  });
  it("중단 접수·원격 확인·원격 완료·실행 미확정을 구분한다", () => {
    expect(aiOutcome({ ...run, status: "cancelling" })).toContain("기다리는");
    expect(aiOutcome({ ...run, status: "cancelled", remoteStatus: "interrupted" })).toContain("확인됐습니다");
    expect(aiOutcome({ ...run, status: "cancelled", remoteStatus: "unknown" })).toContain("확인되지");
    expect(aiOutcome({ ...run, status: "cancelled" })).toContain("겹쳐");
    expect(aiOutcome({ ...run, status: "interrupted" })).toContain("자동 재실행하지");
  });
});
