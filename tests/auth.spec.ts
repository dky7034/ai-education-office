import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { createStore } from "../backend/src/store";
import { accountPanel, signUp, login } from "./accountHelpers";

test("회원가입·로그아웃·로그인 실패·일회용 코드 복구 후 계정 이력을 되찾는다", async ({
  page,
}) => {
  await page.goto("/");
  const account = await signUp(page);
  const workspace = page.locator("#saved-jobs");
  await expect(
    workspace.getByRole("button", { name: "업무 요청 저장", exact: true }),
  ).toBeEnabled();
  await workspace.getByLabel(/업무 제목/).fill("계정 복구 후 확인할 합성 업무");
  await workspace
    .getByLabel(/요청 내용/)
    .fill("비밀번호를 바꿔도 계정의 이력은 유지되어야 합니다.");
  await workspace
    .getByRole("button", { name: "업무 요청 저장", exact: true })
    .click();
  await expect(workspace.locator(".saved-job-list li")).toHaveCount(1);
  const panel = accountPanel(page);
  await panel
    .getByRole("button", { name: "복구 코드 재발급", exact: true })
    .click();
  await panel
    .getByLabel("현재 비밀번호", { exact: true })
    .fill("incorrect-current-passphrase");
  await panel
    .getByRole("button", { name: "새 복구 코드 발급", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("현재 비밀번호");
  await panel
    .getByLabel("현재 비밀번호", { exact: true })
    .fill(account.password);
  await panel
    .getByRole("button", { name: "새 복구 코드 발급", exact: true })
    .click();
  const renewed = await panel
    .getByLabel("계정 복구 코드", { exact: true })
    .textContent();
  expect(renewed !== account.recoveryCode).toBe(true);
  account.recoveryCode = renewed!;
  await panel
    .getByRole("button", { name: "복구 코드 보관 완료", exact: true })
    .click();
  await panel.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(workspace).toHaveCount(0);
  await expect(
    page.getByText("계정 복구 후 확인할 합성 업무", { exact: true }),
  ).toHaveCount(0);
  await panel
    .getByLabel("비밀번호", { exact: true })
    .fill("deliberately-incorrect-passphrase");
  await panel.getByRole("button", { name: "로그인하기", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("아이디 또는 비밀번호");
  await panel
    .getByRole("button", { name: "비밀번호 복구", exact: true })
    .click();
  await panel.getByLabel("계정 아이디", { exact: true }).fill(account.username);
  await panel
    .getByLabel("복구 코드", { exact: true })
    .fill(account.recoveryCode);
  await panel
    .getByLabel("새 비밀번호", { exact: true })
    .fill("replacement-browser-passphrase");
  await panel
    .getByRole("button", { name: "비밀번호 재설정", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("비밀번호를 변경");
  const nextCode = await panel
    .getByLabel("계정 복구 코드", { exact: true })
    .textContent();
  expect(nextCode !== account.recoveryCode).toBe(true);
  await panel
    .getByRole("button", { name: "복구 코드 보관 완료", exact: true })
    .click();
  await login(page, account.username, "replacement-browser-passphrase");
  await expect(workspace.locator(".saved-job-list li")).toHaveCount(1);
  await expect(workspace).toContainText("계정 복구 후 확인할 합성 업무");
  await page.reload();
  await expect(panel.getByLabel("계정 복구 코드", { exact: true })).toHaveCount(
    0,
  );
});

test("기존 브라우저 이력은 동의 버튼으로 가져오며 원본 ID·이벤트를 보존한다", async ({
  page,
  context,
}) => {
  // Only Playwright's explicitly isolated DB; never the user's default DB.
  const filename = process.env.OFFICE_E2E_DB;
  if (!filename || !/e2e(?:-dev)?\.sqlite$/.test(filename))
    throw new Error("테스트 전용 DB 경로가 필요합니다.");
  const store = createStore(filename);
  const raw = randomBytes(32).toString("hex"),
    hash = createHash("sha256").update(raw).digest("hex");
  let jobId: string;
  try {
    store.addSession(hash, Date.now() + 3600000);
    jobId = store.create(hash, "legacy-request-key", {
      kind: "excel",
      title: "기존 브라우저의 합성 업무",
      instructions: "가져오기 검증용 원본 내용입니다.",
    }).job.id;
  } finally {
    store.close();
  }
  const base = new URL(test.info().project.use.baseURL!);
  await context.addCookies([
    {
      name: "office_session",
      value: raw,
      domain: base.hostname,
      path: "/api",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  await page.goto("/");
  const panel = accountPanel(page);
  await expect(panel.locator(".legacy-import")).toContainText("기존 업무 1건");
  await signUp(page);
  const workspace = page.locator("#saved-jobs");
  await expect(workspace).toContainText("아직 저장한 업무가 없습니다.");
  await panel
    .getByRole("button", { name: "기존 이력 가져오기", exact: true })
    .click();
  await expect(workspace.locator(".saved-job-list li")).toHaveCount(1);
  await expect(workspace).toContainText(jobId!);
  await expect(workspace).toContainText("가져오기 검증용 원본 내용");
  await expect(workspace.locator(".saved-events li")).toHaveCount(1);
  await expect(
    panel.getByRole("button", { name: "기존 이력 가져오기", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(workspace.locator(".saved-job-list li")).toHaveCount(1);
});
