import { describe, expect, it } from "vitest";
import { acceptUpdate, parseCursor, cursorText } from "./updateProtocol";
const streamId = "a".repeat(32),
  other = "b".repeat(32);
const cursor = { streamId, sequence: 0 };
const event = (sequence: number) => ({
  sequence,
  type: "run.changed",
  jobId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  fileId: null,
  runId: null,
  state: "completed",
  revision: 1,
  createdAt: "2026-10-22T00:00:00.000Z",
});
const batch = {
  type: "events",
  streamId,
  from: 0,
  to: 2,
  head: 2,
  events: [event(1), event(2)],
};
describe("영구 변경 이벤트 프로토콜", () => {
  it("재연결 재생·겹친 전송·중복을 순서대로 수신하며 중복은 갱신하지 않는다", () => {
    const ready = acceptUpdate(cursor, {
      type: "ready",
      cursor: cursorText(cursor),
      head: 2,
      reset: false,
    });
    expect(ready.replaying).toBe(true);
    const received = acceptUpdate(ready.cursor, batch);
    expect(received.cursor.sequence).toBe(2);
    expect(received.changed).toBe(true);
    expect(received.replaying).toBe(false);
    expect(acceptUpdate(received.cursor, batch).changed).toBe(false);
    expect(
      acceptUpdate({ ...cursor, sequence: 1 }, batch).cursor.sequence,
    ).toBe(2);
    expect(
      acceptUpdate(received.cursor, {
        type: "heartbeat",
        cursor: cursorText(received.cursor),
      }).changed,
    ).toBe(false);
  });
  it("첫 접속·다른 DB·백업 복원 기준점은 reset으로만 수락한다", () => {
    expect(
      acceptUpdate(null, {
        type: "ready",
        cursor: `${other}:10`,
        head: 10,
        reset: true,
      }).reset,
    ).toBe(true);
    expect(() =>
      acceptUpdate(cursor, {
        type: "ready",
        cursor: `${other}:0`,
        head: 0,
        reset: false,
      }),
    ).toThrow();
    expect(() => acceptUpdate(null, batch)).toThrow();
  });
  it("순서 누락·역순·다른 계정/스트림·잘못된 이벤트·미래 heartbeat를 거부한다", () => {
    for (const bad of [
      { ...batch, from: 1, to: 3, head: 3, events: [event(2), event(3)] },
      { ...batch, events: [event(2), event(1)] },
      { ...batch, streamId: other },
      { ...batch, head: 1 },
      { ...batch, events: [] },
      { ...batch, events: [event(1), { ...event(2), type: "execute" }] },
      { ...batch, events: [event(1), { ...event(2), jobId: "invalid" }] },
      { type: "heartbeat", cursor: `${streamId}:1` },
    ])
      expect(() => acceptUpdate(cursor, bad)).toThrow();
  });
  it("안전한 정수·정규 커서만 허용한다", () => {
    expect(parseCursor(`${streamId}:9007199254740991`)?.sequence).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const bad of [
      `${streamId}:9007199254740992`,
      `${streamId}:01`,
      `${streamId}:-1`,
      `${streamId}:1.5`,
      `${streamId}:1e3`,
      "bad",
      null,
    ])
      expect(parseCursor(bad)).toBeNull();
  });
});
