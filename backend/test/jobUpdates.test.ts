import { cursorText } from "../src/activityEvents.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { WebSocket } from "ws";
import { fixture } from "./fixture.ts";
import { createStore } from "../src/store.ts";

const payload = {
  kind: "survey",
  title: "합성 갱신 업무",
  instructions: "가상 연결 확인",
};
const waitFor = async (check: () => boolean) => {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("알림 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("WebSocket은 쿠키·계정·동일 Origin을 요구하고 읽기 알림만 제공한다", async (t) => {
  const f = await fixture({ liveIntervalMs: 20 });
  t.after(() => f.cleanup());
  const a = await f.account(),
    b = await f.account();
  const connect = (cookie: string, account: string, origin?: string) =>
    new WebSocket(
      f.url().replace("http:", "ws:") + "/api/jobs/updates?account=" + account,
      { headers: { cookie, ...(origin ? { Origin: origin } : {}) } },
    );
  for (const [cookie, account, origin, status] of [
    ["", a.user.id, f.url(), 401],
    [a.cookie, b.user.id, f.url(), 401],
    [a.cookie, a.user.id, "https://foreign.invalid", 403],
    [a.cookie, a.user.id, undefined, 403],
    [a.cookie, a.user.id + "&account=" + a.user.id, f.url(), 400],
    [a.cookie, a.user.id + "&unexpected=x", f.url(), 400],
    [a.cookie, a.user.id + "&cursor=bad", f.url(), 400],
    [a.cookie, a.user.id + "&cursor=" + "a".repeat(32) + ":01", f.url(), 400],
    [
      a.cookie,
      a.user.id +
        "&cursor=" +
        "a".repeat(32) +
        ":0&cursor=" +
        "a".repeat(32) +
        ":1",
      f.url(),
      400,
    ],
  ] as const) {
    const ws = connect(cookie, account, origin);
    const response = new Promise<number>((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        ws.terminate();
        resolve(res.statusCode!);
      });
      ws.on("error", () => {});
      ws.on("open", () => reject(new Error("차단되어야 하는 연결")));
    });
    assert.equal(await response, status);
  }
  const ws = connect(a.cookie, a.user.id, f.url());
  t.after(() => ws.terminate());
  const messages: {
    type: string;
    cursor: string;
    head: number;
    reset: boolean;
    to: number;
    events: unknown[];
  }[] = [];
  ws.on("message", (value) => messages.push(JSON.parse(String(value))));
  await once(ws, "open");
  await waitFor(() => messages.length === 1);
  assert.deepEqual(Object.keys(messages[0]!).sort(), [
    "cursor",
    "head",
    "reset",
    "type",
  ]);
  assert.match(messages[0]!.cursor, /^[a-f0-9]{32}:0$/);
  await f.post(payload, b.cookie);
  // Another account's write cannot change this account's cursor.
  const store = createStore(f.filename);
  assert.equal(cursorText(store.activityHead(a.user.id)), messages[0]!.cursor);
  store.close();
  await f.post(payload, a.cookie);
  await waitFor(() => messages.length === 2);
  assert.equal(messages[1]!.type, "events");
  assert.equal(messages[1]!.to, 1);
  const closed = once(ws, "close");
  ws.send(JSON.stringify({ command: "create" }));
  assert.equal((await closed)[0], 1008);
  assert.equal(
    (await (await f.get("/api/jobs", a.cookie)).json()).page.total,
    1,
  );
});

test("끊긴 동안 저장된 변경은 재연결 첫 스냅샷에 반영되고 세션 회수 시 연결을 닫는다", async (t) => {
  const f = await fixture({ liveIntervalMs: 20 });
  t.after(() => f.cleanup());
  const a = await f.account();
  const store = createStore(f.filename);
  t.after(() => store.close());
  const before = cursorText(store.activityHead(a.user.id));
  const job = (await (await f.post(payload, a.cookie)).json()).job;
  const file = (
    await (
      await f.upload(job.id, "합성.csv", Buffer.from("A\n1\n"), a.cookie)
    ).json()
  ).attachment;
  store.saveSelection(a.user.id, job.id, file.id, 0, {
    sheetId: "csv",
    headerRow: 1,
    columns: [0],
  });
  const selected = cursorText(store.activityHead(a.user.id));
  const run = store.enqueueSummary(
    a.user.id,
    job.id,
    file.id,
    1,
    randomUUID(),
  ).run;
  assert.notEqual(cursorText(store.activityHead(a.user.id)), selected);
  store.cancelSummaryRun(a.user.id, job.id, file.id, run.id);
  const after = cursorText(store.activityHead(a.user.id));
  assert.notEqual(after, before);
  await f.restart();
  const ws = new WebSocket(
    f.url().replace("http:", "ws:") + "/api/jobs/updates?account=" + a.user.id,
    { headers: { cookie: a.cookie, Origin: f.url() } },
  );
  t.after(() => ws.terminate());
  const message = once(ws, "message");
  const [value] = await message;
  assert.equal(JSON.parse(String(value)).cursor, after);
  const closed = once(ws, "close");
  store.revokeSession(
    createHash("sha256").update(a.cookie.split("=")[1]!).digest("hex"),
  );
  await closed;
  assert.equal((await f.get("/api/jobs", a.cookie)).status, 401);
});

test("계정별 연결 수를 제한하고 종료 시 업그레이드 소켓도 정리한다", async (t) => {
  const f = await fixture({ liveIntervalMs: 20 });
  t.after(() => f.cleanup());
  const a = await f.account();
  const sockets: WebSocket[] = [];
  t.after(() => sockets.forEach((ws) => ws.terminate()));
  const connect = () =>
    new WebSocket(
      f.url().replace("http:", "ws:") +
        "/api/jobs/updates?account=" +
        a.user.id,
      { headers: { cookie: a.cookie, Origin: f.url() } },
    );
  for (let i = 0; i < 8; i++) {
    const ws = connect();
    sockets.push(ws);
    await once(ws, "open");
  }
  const extra = connect();
  extra.on("error", () => {});
  const denied = new Promise<number>((resolve) =>
    extra.on("unexpected-response", (_req, res) => {
      res.resume();
      extra.terminate();
      resolve(res.statusCode!);
    }),
  );
  assert.equal(await denied, 429);
  const closed = Promise.all(sockets.map((ws) => once(ws, "close")));
  await f.restart();
  await closed;
});

test(
  "계정별 영구 이력 205개를 재시작 후 100개씩 순서대로 재생하고 외부/미래 커서는 스냅샷으로 복구한다",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture({ liveIntervalMs: 20 });
    t.after(() => f.cleanup());
    const a = await f.account(),
      b = await f.account(),
      store = createStore(f.filename);
    t.after(() => store.close());
    const cursor = cursorText(store.activityHead(a.user.id));
    const owner = createHash("sha256")
      .update(a.cookie.split("=")[1]!)
      .digest("hex");
    const ids: string[] = [];
    for (let i = 0; i < 205; i++)
      ids.push(store.create(owner, `replay-${i}`, payload, a.user.id).job.id);
    await f.post(payload, b.cookie);
    await f.restart();
    async function receive(supplied: string, count: number) {
      const ws = new WebSocket(
        f.url().replace("http:", "ws:") +
          "/api/jobs/updates?account=" +
          a.user.id +
          "&cursor=" +
          supplied,
        { headers: { cookie: a.cookie, Origin: f.url() } },
      );
      const messages: Record<string, any>[] = [];
      ws.on("message", (value) => messages.push(JSON.parse(String(value))));
      t.after(() => ws.terminate());
      await waitFor(() => messages.length >= count);
      ws.terminate();
      return messages;
    }
    const messages = await receive(cursor, 4);
    assert.equal(messages[0]!.reset, false);
    assert.equal(messages[0]!.head, 205);
    assert.deepEqual(
      messages.slice(1).map((m) => m.events.length),
      [100, 100, 5],
    );
    const events = messages.slice(1).flatMap((m) => m.events);
    assert.deepEqual(
      events.map((e) => e.sequence),
      Array.from({ length: 205 }, (_, i) => i + 1),
    );
    assert.deepEqual(
      events.map((e) => e.jobId),
      ids,
    );
    assert.ok(
      events.every(
        (e) =>
          e.type === "job.created" &&
          !JSON.stringify(e).includes(payload.instructions),
      ),
    );
    const resumed = await receive(cursor.replace(/:0$/, ":200"), 2);
    assert.deepEqual(
      resumed[1]!.events.map((e: any) => e.sequence),
      [201, 202, 203, 204, 205],
    );
    for (const supplied of [
      cursorText(store.activityHead(b.user.id)),
      cursor.replace(/:0$/, ":206"),
    ]) {
      const [reset] = await receive(supplied, 1);
      assert.equal(reset!.reset, true);
      assert.equal(reset!.cursor, cursorText(store.activityHead(a.user.id)));
    }
  },
);

test(
  "재생 중 세션을 회수하면 다음 묶음 전에 종료한다",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture({ liveIntervalMs: 50 });
    t.after(() => f.cleanup());
    const a = await f.account(),
      store = createStore(f.filename);
    t.after(() => store.close());
    const owner = createHash("sha256")
      .update(a.cookie.split("=")[1]!)
      .digest("hex");
    const cursor = cursorText(store.activityHead(a.user.id));
    for (let i = 0; i < 101; i++)
      store.create(owner, `revoke-${i}`, payload, a.user.id);
    const ws = new WebSocket(
      f.url().replace("http:", "ws:") +
        "/api/jobs/updates?account=" +
        a.user.id +
        "&cursor=" +
        cursor,
      { headers: { cookie: a.cookie, Origin: f.url() } },
    );
    t.after(() => ws.terminate());
    let count = 0;
    const closed = once(ws, "close");
    ws.on("message", (value) => {
      const data = JSON.parse(String(value));
      if (data.type === "events") {
        count += data.events.length;
        store.revokeSession(owner);
      }
    });
    await closed;
    assert.equal(count, 100);
  },
);

test(
  "저장 이력에 틈이 생기면 조용히 건너뛰지 않고 기준점 재설정을 알린다",
  { timeout: 10000 },
  async (t) => {
    const { DatabaseSync } = await import("node:sqlite");
    const f = await fixture({ liveIntervalMs: 20 }),
      a = await f.account(),
      s = createStore(f.filename);
    t.after(async () => {
      s.close();
      await f.cleanup();
    });
    const cursor = cursorText(s.activityHead(a.user.id));
    const owner = createHash("sha256")
      .update(a.cookie.split("=")[1]!)
      .digest("hex");
    for (let i = 0; i < 3; i++) s.create(owner, `gap-${i}`, payload, a.user.id);
    const db = new DatabaseSync(f.filename);
    db.exec("DROP TRIGGER activity_immutable_delete");
    db.prepare(
      "DELETE FROM activity_events WHERE account_id=? AND sequence=2",
    ).run(a.user.id);
    db.close();
    const ws = new WebSocket(
      f.url().replace("http:", "ws:") +
        "/api/jobs/updates?account=" +
        a.user.id +
        "&cursor=" +
        cursor,
      { headers: { cookie: a.cookie, Origin: f.url() } },
    );
    t.after(() => ws.terminate());
    const messages: { type: string; reset: boolean; cursor: string }[] = [];
    ws.on("message", (value) => messages.push(JSON.parse(String(value))));
    await waitFor(() => messages.length === 2);
    assert.deepEqual(
      messages.map((m) => [m.type, m.reset]),
      [
        ["ready", false],
        ["ready", true],
      ],
    );
    assert.equal(messages[1]!.cursor, cursorText(s.activityHead(a.user.id)));
    assert.equal(
      (await (await f.get("/api/jobs", a.cookie)).json()).page.total,
      3,
    );
  },
);
