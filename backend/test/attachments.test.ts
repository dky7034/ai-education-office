import { dropActivitySchema } from "./migrationHelpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { ZipFile } from "yazl";
import { fixture } from "./fixture.ts";
import { validateFile, MAX_FILE_BYTES } from "../src/attachments.ts";
const input = {
  kind: "excel",
  title: "합성 파일 보관",
  instructions: "원본만 보관합니다.",
};
const csv = Buffer.from('\uFEFF항목,수\r\n"가상,과정",2\r\n');
async function zip(entries: Record<string, string | Buffer>) {
  const archive = new ZipFile();
  for (const [name, data] of Object.entries(entries))
    archive.addBuffer(Buffer.from(data), name);
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", (chunk) => chunks.push(chunk));
    archive.outputStream.on("error", reject);
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  archive.end();
  return done;
}
const parts = {
  "[Content_Types].xml":
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  "_rels/.rels":
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  "xl/workbook.xml":
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="합성" sheetId="1" r:id="r1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  "xl/worksheets/sheet1.xml":
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
};
test("CSV·XLSX 원본·해시·파일명을 보존하고 재시작 후 다운로드한다", async () => {
  const f = await fixture();
  try {
    const cookie = await f.session();
    const { job } = await (await f.post(input, cookie)).json();
    for (const [name, bytes] of [
      ["가상 설문.csv", csv],
      ["합성.xlsx", await zip(parts)],
    ] as const) {
      const r = await f.upload(
        job.id,
        name,
        bytes,
        cookie,
        `upload-${name.length}`,
      );
      assert.equal(r.status, 201);
      const { attachment } = await r.json();
      assert.equal(attachment.name, name);
      assert.equal(
        attachment.sha256,
        createHash("sha256").update(bytes).digest("hex"),
      );
      await f.restart();
      const response = await f.get(
        `/api/jobs/${job.id}/attachments/${attachment.id}`,
        cookie,
      );
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("content-type"),
        "application/octet-stream",
      );
      assert.match(response.headers.get("content-disposition")!, /attachment;/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
    assert.equal(
      (await (await f.get(`/api/jobs/${job.id}/attachments`, cookie)).json())
        .attachments.length,
      2,
    );
  } finally {
    await f.cleanup();
  }
});
test("첨부 목록·업로드·다운로드 권한, CSRF와 계정 전환을 검사한다", async () => {
  const f = await fixture();
  try {
    const a = await f.account(),
      b = await f.account();
    const { job } = await (await f.post(input, a.cookie)).json();
    const { attachment } = await (
      await f.upload(job.id, "가상.csv", csv, a.cookie)
    ).json();
    for (const [cookie, status] of [
      ["", 401],
      [b.cookie, 404],
    ] as const) {
      assert.equal(
        (await f.get(`/api/jobs/${job.id}/attachments`, cookie)).status,
        status,
      );
      assert.equal(
        (
          await f.get(
            `/api/jobs/${job.id}/attachments/${attachment.id}`,
            cookie,
          )
        ).status,
        status,
      );
      assert.equal(
        (await f.upload(job.id, "가상.csv", csv, cookie)).status,
        status,
      );
    }
    for (const extra of [
      { Origin: "https://external.invalid" },
      { "X-Office-Request": "" },
      { "Content-Type": "text/plain" },
    ])
      assert.equal(
        (
          await f.upload(
            job.id,
            "가상.csv",
            csv,
            a.cookie,
            "upload-csrf",
            extra,
          )
        ).status,
        403,
      );
    assert.equal(
      (
        await f.upload(job.id, "가상.csv", csv, a.cookie, "upload-account", {
          "X-Office-Account": b.user.id,
        })
      ).status,
      401,
    );
  } finally {
    await f.cleanup();
  }
});
test("빈 파일·위장·잘못된 CSV·경로 파일명·크기 초과는 저장하지 않는다", async () => {
  const f = await fixture();
  try {
    const cookie = await f.session();
    const { job } = await (await f.post(input, cookie)).json();
    for (const [name, data] of [
      ["empty.csv", Buffer.alloc(0)],
      ["bad.exe", csv],
      ["../bad.csv", csv],
      ["bad.xlsx", csv],
      ["binary.csv", Buffer.from([0xff, 0])],
      ["bad.csv", Buffer.from('a,b\n"unclosed')],
    ] as const)
      assert.equal((await f.upload(job.id, name, data, cookie)).status, 400);
    assert.equal(
      (
        await f.upload(
          job.id,
          "huge.csv",
          Buffer.alloc(MAX_FILE_BYTES + 1, 65),
          cookie,
        )
      ).status,
      413,
    );
    assert.equal(
      (await (await f.get(`/api/jobs/${job.id}/attachments`, cookie)).json())
        .attachments.length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
test("손상 XML·일반 ZIP·매크로·압축 폭탄과 CRC 손상을 거부한다", async () => {
  for (const entries of [
    { "note.txt": "hello" },
    { ...parts, "xl/workbook.xml": "<broken>" },
    { ...parts, "xl/vbaProject.bin": "macro" },
    { ...parts, "huge.txt": Buffer.alloc(21 * 1024 * 1024, 65) },
  ])
    await assert.rejects(validateFile("bad.xlsx", await zip(entries)));
  const archive = await zip(parts);
  const crcOffset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16;
  archive[crcOffset] = archive[crcOffset]! ^ 0xff;
  await assert.rejects(validateFile("bad.xlsx", archive));
});
test("동시 재전송은 한 파일, 다른 내용은 충돌, 개수 제한은 동시 요청에도 유지한다", async () => {
  const f = await fixture();
  try {
    const cookie = await f.session();
    const { job } = await (await f.post(input, cookie)).json();
    const rs = await Promise.all([
      f.upload(job.id, "가상.csv", csv, cookie),
      f.upload(job.id, "가상.csv", csv, cookie),
    ]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 201]);
    assert.equal((await f.upload(job.id, "다름.csv", csv, cookie)).status, 409);
    const more = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        f.upload(job.id, "가상.csv", csv, cookie, `upload-more-${i}`),
      ),
    );
    assert.equal(more.filter((r) => r.status === 201).length, 4);
    assert.equal(more.filter((r) => r.status === 409).length, 2);
    assert.equal((await f.upload(job.id, "가상.csv", csv, cookie)).status, 200);
    assert.equal(
      readdirSync(join(dirname(f.filename), "attachments", job.id)).length,
      5,
    );
  } finally {
    await f.cleanup();
  }
});
test("분실·변조된 원본은 다운로드하지 않는다", async () => {
  const f = await fixture();
  try {
    const cookie = await f.session();
    const { job } = await (await f.post(input, cookie)).json();
    const { attachment } = await (
      await f.upload(job.id, "가상.csv", csv, cookie)
    ).json();
    const path = join(
      dirname(f.filename),
      "attachments",
      job.id,
      attachment.id,
    );
    unlinkSync(path);
    assert.equal(
      (await f.get(`/api/jobs/${job.id}/attachments/${attachment.id}`, cookie))
        .status,
      409,
    );
    writeFileSync(path, "tampered");
    assert.equal(
      (await f.get(`/api/jobs/${job.id}/attachments/${attachment.id}`, cookie))
        .status,
      409,
    );
  } finally {
    await f.cleanup();
  }
});

test("경계 크기의 CSV와 여러 행의 인용 필드를 허용한다", async () => {
  assert.equal(
    await validateFile("boundary.csv", Buffer.alloc(MAX_FILE_BYTES, 65)),
    "csv",
  );
  for (const text of [
    'a,b\n"one\ntwo","say ""yes"""\n',
    'a;b\n"one;two";3\n',
    'a\tb\n"one\ttwo"\t3\n',
  ])
    assert.equal(await validateFile("quoted.csv", Buffer.from(text)), "csv");
});

test("v2 계정·업무·이벤트를 v3 첨부 테이블 추가 후에도 보존한다", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createStore } = await import("../src/store.ts");
  let accountId = "",
    jobId = "";
  const f = await fixture({
    seed(filename) {
      const store = createStore(filename);
      const user = store.register(
        "migration_user",
        "synthetic-unused-password-hash",
        "synthetic-unused-recovery-hash",
      )!;
      accountId = user.id;
      store.addAuthSession(
        "synthetic-session-id",
        user.id,
        Date.now() + 60_000,
      );
      const result = store.create(
        "synthetic-session-id",
        "migration-request",
        { ...input, kind: "excel" },
        user.id,
      );
      jobId = result.job.id;
      store.close();
      const db = new DatabaseSync(filename);
      dropActivitySchema(db);
      db.exec(
        "DROP TABLE summary_run_reviews; DROP TABLE summary_run_artifacts; DROP TABLE summary_run_events; DROP TABLE summary_runs; DROP TABLE summary_queue_lease; DROP TABLE column_selections; DROP TABLE attachments; PRAGMA user_version=2;",
      );
      db.close();
    },
  });
  try {
    const store = createStore(f.filename);
    try {
      assert.equal(store.detail(accountId, jobId)!.job.title, input.title);
      assert.equal(store.detail(accountId, jobId)!.events.length, 1);
      assert.deepEqual(store.attachments(accountId, jobId), []);
    } finally {
      store.close();
    }
    const db = new DatabaseSync(f.filename, { readOnly: true });
    try {
      assert.equal(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
        11,
      );
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally {
      db.close();
    }
  } finally {
    await f.cleanup();
  }
});
