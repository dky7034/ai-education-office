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
  const messages: { type: string; revision: string }[] = [];
  ws.on("message", (value) => messages.push(JSON.parse(String(value))));
  await once(ws, "open");
  await waitFor(() => messages.length === 1);
  assert.deepEqual(Object.keys(messages[0]!).sort(), ["revision", "type"]);
  assert.match(messages[0]!.revision, /^[a-f0-9]{64}$/);
  await f.post(payload, b.cookie);
  // Another account's write cannot change this account's cursor.
  const store = createStore(f.filename);
  assert.equal(store.activityRevision(a.user.id), messages[0]!.revision);
  store.close();
  await f.post(payload, a.cookie);
  await waitFor(() => messages.length === 2);
  assert.notEqual(messages[1]!.revision, messages[0]!.revision);
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
  const before = store.activityRevision(a.user.id);
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
  const selected = store.activityRevision(a.user.id);
  const run = store.enqueueSummary(
    a.user.id,
    job.id,
    file.id,
    1,
    randomUUID(),
  ).run;
  assert.notEqual(store.activityRevision(a.user.id), selected);
  store.cancelSummaryRun(a.user.id, job.id, file.id, run.id);
  const after = store.activityRevision(a.user.id);
  assert.notEqual(after, before);
  await f.restart();
  const ws = new WebSocket(
    f.url().replace("http:", "ws:") + "/api/jobs/updates?account=" + a.user.id,
    { headers: { cookie: a.cookie, Origin: f.url() } },
  );
  t.after(() => ws.terminate());
  const message = once(ws, "message");
  const [value] = await message;
  assert.equal(JSON.parse(String(value)).revision, after);
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
