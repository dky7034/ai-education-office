import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fixture, cookie, testPassword } from "./fixture.ts";

const input = {
  kind: "survey",
  title: "계정 이력 복원 검증",
  instructions: "합성 업무 요청입니다.",
};
test("회원가입·로그인 세션 교체·로그아웃·다른 브라우저 복원·만료를 처리한다", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get("/api/jobs")).status, 401);
    const a = await f.account();
    const session = await (await f.get("/api/auth/session", a.cookie)).json();
    assert.equal(session.user.id, a.user.id);
    assert.equal("passwordHash" in session.user, false);
    assert.equal("recoveryHash" in session.user, false);
    const { job } = await (await f.post(input, a.cookie)).json();
    const second = await f.auth("login", {
      username: a.username.toUpperCase(),
      password: a.password,
    });
    assert.equal(second.status, 200);
    assert.equal(cookie(second) !== a.cookie, true);
    assert.equal(
      (await (await f.get("/api/jobs", cookie(second))).json()).jobs[0].id,
      job.id,
    );
    assert.equal((await f.post(input, cookie(second))).status, 200); // Account-scoped idempotency.
    const rotated = await f.auth(
      "login",
      { username: a.username, password: a.password },
      cookie(second),
    );
    assert.equal((await f.get("/api/jobs", cookie(second))).status, 401);
    assert.equal((await f.auth("logout", {}, cookie(rotated))).status, 200);
    assert.equal((await f.get("/api/jobs", cookie(rotated))).status, 401);
    assert.equal((await f.get("/api/jobs", a.cookie)).status, 200); // Other browser remains signed in.
    const db = new DatabaseSync(f.filename);
    db.prepare("UPDATE sessions SET expires_at = 0 WHERE user_id = ?").run(
      a.user.id,
    );
    db.close();
    assert.equal((await f.get("/api/jobs", a.cookie)).status, 401);
    await f.restart();
    const again = await f.auth("login", {
      username: a.username,
      password: a.password,
    });
    assert.equal(
      (await (await f.get("/api/jobs", cookie(again))).json()).jobs[0].id,
      job.id,
    );
  } finally {
    await f.cleanup();
  }
});

test("비밀번호를 개별 salt의 scrypt 해시로만 저장하고 인증·입력을 검증한다", async () => {
  const f = await fixture();
  try {
    const a = await f.account(),
      b = await f.account();
    const db = new DatabaseSync(f.filename, { readOnly: true });
    const rows = db
      .prepare("SELECT password_hash, recovery_hash FROM users")
      .all() as { password_hash: string; recovery_hash: string }[];
    assert.equal(
      rows.every(
        (row) =>
          row.password_hash.startsWith("scrypt-v1$") &&
          !row.password_hash.includes(testPassword),
      ),
      true,
    );
    assert.equal(rows[0].password_hash === rows[1].password_hash, false);
    assert.equal(
      rows.every((row) => !row.recovery_hash.includes(a.recoveryCode)),
      true,
    );
    db.close();
    assert.equal(
      (await f.auth("register", { username: a.username, password: a.password }))
        .status,
      409,
    );
    for (const body of [
      {},
      { username: "__bad", password: a.password },
      { username: "abc", password: "short" },
      { username: "abc", password: "x".repeat(129) },
    ])
      assert.equal((await f.auth("register", body)).status, 400);
    const wrong = await f.auth("login", {
      username: a.username,
      password: "wrong-but-long-password",
    });
    const unknown = await f.auth("login", {
      username: "not_existing_user",
      password: "wrong-but-long-password",
    });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), await unknown.json());
    const { job } = await (await f.post(input, a.cookie)).json();
    assert.equal((await f.get(`/api/jobs/${job.id}`, b.cookie)).status, 404);
    assert.equal(
      (await f.get(`/api/jobs/${job.id}/events`, b.cookie)).status,
      404,
    );
    assert.equal(
      (
        await f.post(input, b.cookie, "account-guard-key", {
          "X-Office-Account": a.user.id,
        })
      ).status,
      401,
    );
    assert.equal(
      (await (await f.get("/api/jobs", b.cookie)).json()).page.total,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("복구 코드는 한 번만 사용하고 비밀번호 변경 시 모든 세션을 회수한다", async () => {
  const f = await fixture();
  try {
    const a = await f.account();
    const { job } = await (await f.post(input, a.cookie)).json();
    const second = cookie(
      await f.auth("login", { username: a.username, password: a.password }),
    );
    const newPassword = "replacement-synthetic-passphrase";
    const reset = await f.auth("recover", {
      username: a.username,
      recoveryCode: a.recoveryCode,
      password: newPassword,
    });
    assert.equal(reset.status, 200);
    const next = await reset.json();
    assert.equal(next.recoveryCode !== a.recoveryCode, true);
    assert.equal((await f.get("/api/jobs", a.cookie)).status, 401);
    assert.equal((await f.get("/api/jobs", second)).status, 401);
    assert.equal(
      (await f.auth("login", { username: a.username, password: a.password }))
        .status,
      401,
    );
    assert.equal(
      (
        await f.auth("recover", {
          username: a.username,
          recoveryCode: a.recoveryCode,
          password: newPassword,
        })
      ).status,
      400,
    );
    const signedIn = cookie(
      await f.auth("login", { username: a.username, password: newPassword }),
    );
    assert.equal(
      (await (await f.get("/api/jobs", signedIn)).json()).jobs[0].id,
      job.id,
    );
    const concurrent = await Promise.all(
      [0, 1].map(() =>
        f.auth("recover", {
          username: a.username,
          recoveryCode: next.recoveryCode,
          password: "second-replacement-passphrase",
        }),
      ),
    );
    assert.deepEqual(
      concurrent.map((response) => response.status).sort(),
      [200, 400],
    );
  } finally {
    await f.cleanup();
  }
});

test("복구 코드 재발급은 현재 비밀번호를 확인하고 이전 코드를 무효화한다", async () => {
  const f = await fixture();
  try {
    const a = await f.account();
    assert.equal(
      (
        await f.auth(
          "renew-recovery",
          { password: "incorrect-current-password" },
          a.cookie,
        )
      ).status,
      401,
    );
    const response = await f.auth(
      "renew-recovery",
      { password: a.password },
      a.cookie,
    );
    assert.equal(response.status, 200);
    const next = await response.json();
    assert.equal(
      (
        await f.auth("recover", {
          username: a.username,
          recoveryCode: a.recoveryCode,
          password: "new-synthetic-password",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.auth("recover", {
          username: a.username,
          recoveryCode: next.recoveryCode,
          password: "new-synthetic-password",
        })
      ).status,
      200,
    );
  } finally {
    await f.cleanup();
  }
});

test("인증 시도 제한·CSRF·보안 쿠키·비캐시 응답을 확인한다", async () => {
  const f = await fixture({ authRateLimit: 3 });
  try {
    const a = await f.account();
    await f.restart();
    for (let i = 0; i < 3; i++)
      assert.equal(
        (
          await f.auth("login", {
            username: a.username,
            password: "incorrect-synthetic-password",
          })
        ).status,
        401,
      );
    const blocked = await f.auth("login", {
      username: a.username,
      password: a.password,
    });
    assert.equal(blocked.status, 429);
    assert.equal(Number(blocked.headers.get("retry-after")) > 0, true);
    assert.equal(
      (
        await f.auth("logout", {}, a.cookie, {
          Origin: "https://outside.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.auth("logout", {}, a.cookie, { "X-Office-Request": "" })).status,
      403,
    );
    const session = await f.get("/api/auth/session", a.cookie);
    assert.equal(session.headers.get("cache-control"), "no-store");
    const valid = await f.auth("login", {
      username: "unregistered_account",
      password: "incorrect-synthetic-password",
    });
    assert.equal(valid.status, 401);
  } finally {
    await f.cleanup();
  }
});

test("v1 업무·이벤트를 보존하고 기존 쿠키 증명으로만 계정에 가져온다", async () => {
  const raw = randomBytes(32).toString("hex"),
    owner = createHash("sha256").update(raw).digest("hex"),
    jobId = randomUUID();
  const legacyCookie = `office_session=${raw}`;
  const f = await fixture({
    seed(filename) {
      const db = new DatabaseSync(filename);
      db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE jobs(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES sessions(id), request_key TEXT NOT NULL, payload_hash TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL, assigned_staff TEXT NOT NULL, status TEXT NOT NULL, execution_mode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id, request_key));
      CREATE TABLE job_events(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), type TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL); PRAGMA user_version=1;`);
      db.prepare("INSERT INTO sessions VALUES(?, ?)").run(
        owner,
        Date.now() + 3600000,
      );
      db.prepare(
        "INSERT INTO jobs VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        jobId,
        owner,
        "request-test-1",
        "old-hash",
        "survey",
        "이전 버전 합성 업무",
        "원본 요청 내용",
        "analyst",
        "received",
        "not_connected",
        "2026-10-21T00:00:00.000Z",
        "2026-10-21T00:00:00.000Z",
      );
      db.prepare("INSERT INTO job_events VALUES(?, ?, ?, ?, ?)").run(
        randomUUID(),
        jobId,
        "request_received",
        "원본 접수 이벤트",
        "2026-10-21T00:00:00.000Z",
      );
      db.close();
    },
  });
  try {
    assert.equal(
      (await (await f.get("/api/auth/session", legacyCookie)).json())
        .legacyCount,
      1,
    );
    assert.equal((await f.get("/api/jobs", legacyCookie)).status, 401);
    assert.equal((await f.auth("import-legacy", {}, legacyCookie)).status, 401);
    const a = await f.account(),
      b = await f.account();
    await f.post(input, a.cookie); // Same key as old request must not prevent migration.
    assert.equal(
      (await (await f.get("/api/jobs", a.cookie)).json()).page.total,
      1,
    );
    assert.equal(
      (await (await f.auth("import-legacy", {}, a.cookie)).json()).imported,
      0,
    );
    const claimed = await f.auth(
      "import-legacy",
      {},
      a.cookie + "; " + legacyCookie,
    );
    assert.equal((await claimed.json()).imported, 1);
    const restored = await (await f.get(`/api/jobs/${jobId}`, a.cookie)).json();
    assert.equal(restored.job.instructions, "원본 요청 내용");
    assert.equal(restored.events[0].message, "원본 접수 이벤트");
    assert.equal(
      (
        await (
          await f.auth("import-legacy", {}, b.cookie + "; " + legacyCookie)
        ).json()
      ).imported,
      0,
    );
    assert.equal((await f.get(`/api/jobs/${jobId}`, b.cookie)).status, 404);
    await f.restart();
    assert.equal((await f.get(`/api/jobs/${jobId}`, a.cookie)).status, 200);
    const db = new DatabaseSync(f.filename, { readOnly: true });
    assert.equal(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      9,
    );
    db.close();
  } finally {
    await f.cleanup();
  }
});
