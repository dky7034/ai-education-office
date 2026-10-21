import { describe, expect, it } from "vitest";
import {
  createStaff,
  initialState,
  isRunning,
  officeReducer,
  TASKS,
  TIMELINE,
} from "./simulation";

describe("오피스 시뮬레이션", () => {
  it("직원 6명은 독립된 초기 상태로 시작한다", () => {
    const people = createStaff();
    expect(new Set(people.map((p) => p.id)).size).toBe(6);
    expect(people.every((p) => p.status === "대기 중" && p.task === null)).toBe(
      true,
    );
    people[0].history.push("외부 변경");
    expect(createStaff()[0].history).toEqual([]);
  });
  it.each(TASKS)("$title 업무의 배정, 이동, 검토, 완료를 연결한다", (task) => {
    let state = officeReducer(initialState(), {
      type: "start",
      kind: task.id,
      id: "test-job",
      time: "09:00:00",
    });
    expect(isRunning(state)).toBe(true);
    expect(state.staff.find((p) => p.id === task.staff)?.task).toBe(task.title);
    for (const step of TIMELINE) {
      state = officeReducer(state, {
        type: "advance",
        jobId: "test-job",
        phase: step.phase,
        time: "09:00:01",
      });
      expect(state.job?.phase).toBe(step.phase);
      const employee = state.staff.find((p) => p.id === task.staff)!;
      if (step.phase === "moving") {
        expect(employee.status).toBe("이동 중");
        expect(employee.target).toEqual(employee.desk);
      }
      if (step.phase === "working") expect(employee.status).toBe(task.action);
      if (step.phase === "reviewing") {
        expect(employee.target.y).toBe(606);
        expect(state.staff[0].status).toBe("검토 중");
      }
    }
    expect(isRunning(state)).toBe(false);
    expect(state.staff.find((p) => p.id === task.staff)?.history).toEqual([
      `${task.title} · 시연 완료`,
    ]);
    expect(state.logs.at(-1)?.text).toContain(
      "실제 결과물 생성·사용자 승인·외부 발송은 수행하지 않았습니다",
    );
  });
  it("중복 시작, 이전 작업의 타이머, 순서가 어긋난 이벤트는 무시한다", () => {
    const state = officeReducer(initialState(), {
      type: "start",
      kind: "survey",
      id: "current",
      time: "09:00",
    });
    expect(
      officeReducer(state, {
        type: "start",
        kind: "slides",
        id: "other",
        time: "09:01",
      }),
    ).toBe(state);
    expect(
      officeReducer(state, {
        type: "advance",
        jobId: "old",
        phase: "moving",
        time: "09:01",
      }),
    ).toBe(state);
    expect(
      officeReducer(state, {
        type: "advance",
        jobId: "current",
        phase: "completed",
        time: "09:01",
      }),
    ).toBe(state);
  });
  it("오류는 진행을 종료하며 새 작업으로 다시 시연할 수 있다", () => {
    let state = officeReducer(initialState(), {
      type: "start",
      kind: "monitor",
      id: "one",
      time: "09:00",
    });
    state = officeReducer(state, {
      type: "advance",
      jobId: "one",
      phase: "failed",
      time: "09:01",
    });
    expect(state.staff.find((p) => p.id === "learner")?.status).toBe(
      "오류 발생",
    );
    expect(isRunning(state)).toBe(false);
    expect(
      officeReducer(state, {
        type: "advance",
        jobId: "one",
        phase: "moving",
        time: "09:02",
      }),
    ).toBe(state);
    state = officeReducer(state, {
      type: "start",
      kind: "schedule",
      id: "two",
      time: "09:03",
    });
    expect(state.job?.kind).toBe("schedule");
    expect(isRunning(state)).toBe(true);
  });
  it("초기화 후 이전 이벤트는 복구되지 않는다", () => {
    let state = officeReducer(initialState(), {
      type: "start",
      kind: "excel",
      id: "old",
      time: "09:00",
    });
    state = officeReducer(state, { type: "reset" });
    expect(state).toEqual(initialState());
    expect(
      officeReducer(state, {
        type: "advance",
        jobId: "old",
        phase: "moving",
        time: "09:01",
      }),
    ).toBe(state);
  });
});
