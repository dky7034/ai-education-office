import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.ts";
const input = {
  kind: "survey",
  title: "가상 설문 집계 요청",
  instructions: "가상 과정의 응답 수와 누락 항목을 확인해 주세요.",
};

test("접수 상태·UUID·담당 역할·이벤트를 저장하고 서버 재시작 후 복원한다", async () => {
  const f = await fixture();
  try {
    const cookie = await f.session();
    const response = await f.post(input, cookie);
    assert.equal(response.status, 201);
    const { job } = await response.json();
    assert.match(job.id, /^[0-9a-f-]{36}$/);
    assert.equal(job.status, "received");
    assert.equal(job.executionMode, "not_connected");
    assert.equal(job.assignedStaff, "analyst");
    assert.equal("owner_id" in job, false);
    await f.restart();
    const list = await (await f.get("/api/jobs", cookie)).json();
    assert.equal(list.jobs.length, 1);
    assert.equal(list.jobs[0].id, job.id);
    const detail = await (await f.get(`/api/jobs/${job.id}`, cookie)).json();
    assert.equal(detail.job.instructions, input.instructions);
    assert.equal(detail.events.length, 1);
    assert.equal(detail.events[0].type, "request_received");
    assert.match(
      detail.events[0].message,
      /자동 실행은 아직 연결되지 않았습니다/,
    );
    assert.equal(
      (await (await f.get(`/api/jobs/${job.id}/events`, cookie)).json()).events
        .length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("같은 요청을 동시 재전송해도 업무·이벤트를 하나만 저장한다", async () => {
  const f = await fixture();
  try {
    const cookie = await f.session();
    const responses = await Promise.all([
      f.post(input, cookie),
      f.post(input, cookie),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
    const results = await Promise.all(responses.map((r) => r.json()));
    assert.equal(results[0].job.id, results[1].job.id);
    const detail = await (
      await f.get(`/api/jobs/${results[0].job.id}`, cookie)
    ).json();
    assert.equal(detail.events.length, 1);
    assert.equal(
      (await (await f.get("/api/jobs", cookie)).json()).page.total,
      1,
    );
    assert.equal(
      (await f.post({ ...input, title: "다른 요청 내용" }, cookie)).status,
      409,
    );
  } finally {
    await f.cleanup();
  }
});

test("다른 계정은 목록·상세·이벤트에 접근할 수 없다", async () => {
  const f = await fixture();
  try {
    const a = await f.session(),
      b = await f.session();
    const { job } = await (await f.post(input, a)).json();
    assert.equal((await (await f.get("/api/jobs", b)).json()).jobs.length, 0);
    assert.equal((await f.get(`/api/jobs/${job.id}`, b)).status, 404);
    assert.equal((await f.get(`/api/jobs/${job.id}/events`, b)).status, 404);
    assert.equal((await f.post(input, b)).status, 201); // Same key is scoped to the owner.
  } finally {
    await f.cleanup();
  }
});

test("제목·내용·업무 종류·서버 전용 필드 검증 실패는 저장하지 않는다", async () => {
  const f = await fixture();
  try {
    const cookie = await f.session();
    for (const body of [
      null,
      [],
      {},
      { ...input, kind: "__proto__" },
      { ...input, title: " " },
      { ...input, title: "가".repeat(101) },
      { ...input, instructions: " " },
      { ...input, instructions: "가".repeat(5001) },
      { ...input, status: "completed" },
      { ...input, ownerId: "someone" },
    ]) {
      assert.equal((await f.post(body, cookie)).status, 400);
    }
    assert.equal(
      (await (await f.get("/api/jobs", cookie)).json()).page.total,
      0,
    );
    assert.equal((await f.post(input, cookie, "bad")).status, 400);
    assert.equal(
      (
        await f.post(
          { ...input, title: "  정상 요청  ", instructions: "  확인 요청  " },
          cookie,
        )
      ).status,
      201,
    );
    const { jobs } = await (await f.get("/api/jobs", cookie)).json();
    assert.equal(jobs[0].title, "정상 요청");
    assert.equal(jobs[0].instructions, "확인 요청");
  } finally {
    await f.cleanup();
  }
});

test("세션 없는 저장·외부 Origin·폼 전송·과도한 본문을 거부한다", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post(input, "")).status, 401);
    const cookie = await f.session();
    const initial = await f.get("/api/jobs", cookie);
    assert.equal(initial.headers.get("cache-control"), "no-store");
    assert.equal(
      (
        await f.post(input, cookie, "request-origin", {
          Origin: "https://untrusted.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.post(input, cookie, "request-form", {
          "Content-Type": "text/plain",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.post(input, cookie, "request-header", {
          "X-Office-Request": "",
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.post({ ...input, instructions: "x".repeat(40000) }, cookie))
        .status,
      413,
    );
    assert.equal(
      (await (await f.get("/api/jobs", cookie)).json()).page.total,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("모든 업무 종류의 담당자를 서버가 결정한다", async () => {
  const f = await fixture();
  try {
    const cookie = await f.session();
    for (const [kind, assignee] of Object.entries({
      survey: "analyst",
      notice: "writer",
      monitor: "learner",
      excel: "analyst",
      slides: "designer",
      schedule: "coordinator",
    })) {
      const { job } = await (
        await f.post({ ...input, kind }, cookie, `request-${kind}`)
      ).json();
      assert.equal(job.assignedStaff, assignee);
    }
  } finally {
    await f.cleanup();
  }
});

test("페이지별 조회·잘못된 페이지·없는 ID를 처리한다", async () => {
  const f = await fixture();
  try {
    const cookie = await f.session();
    for (let i = 0; i < 3; i++)
      await f.post(input, cookie, `request-page-${i}`);
    const first = await (await f.get("/api/jobs?limit=2", cookie)).json();
    const second = await (
      await f.get("/api/jobs?limit=2&offset=2", cookie)
    ).json();
    assert.equal(first.page.total, 3);
    assert.equal(first.page.hasMore, true);
    assert.equal(second.page.hasMore, false);
    assert.equal(
      new Set([...first.jobs, ...second.jobs].map((j) => j.id)).size,
      3,
    );
    for (const query of [
      "limit=101",
      "offset=-1",
      "limit=1.5",
      "offset=x",
      "limit=1&limit=2",
    ])
      assert.equal((await f.get(`/api/jobs?${query}`, cookie)).status, 400);
    assert.equal((await f.get("/api/jobs/not-an-id", cookie)).status, 404);
    assert.equal((await f.get("/api/missing", cookie)).status, 404);
  } finally {
    await f.cleanup();
  }
});
