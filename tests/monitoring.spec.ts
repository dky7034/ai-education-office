import { expect, test } from "@playwright/test";
import { registerViaApi } from "./accountHelpers";
async function setup(page: import("@playwright/test").Page) {
  await registerViaApi(page);
  const job = (await (await page.request.post("/api/jobs", {headers: {"X-Office-Request": "1", "Idempotency-Key": "monitoring-job"},
    data: {kind: "monitor", title: "가상 지표 연결", instructions: "원문 자료만 확인"}})).json()).job;
  const file = (await (await page.request.post(`/api/jobs/${job.id}/attachments`, {headers: {"X-Office-Request": "1", "Content-Type": "application/octet-stream",
    "X-File-Name": encodeURIComponent("가상 지표.csv"), "Idempotency-Key": "monitoring-file"}, data: Buffer.from("가상 기록,가상 보조\n90,참고\n80,다음\n")})).json()).attachment;
  const base = `/api/jobs/${job.id}/attachments/${file.id}`, settings = {sheetId: "csv", headerRow: 1, columns: [0, 1], revision: 0};
  expect((await page.request.put(base + "/selection", {headers: {"X-Office-Request": "1"}, data: settings})).status()).toBe(200);
  await page.goto(`/?job=${job.id}`); await page.getByRole("button", {name: "가상 지표.csv 미리보기", exact: true}).click();
  return {base, settings};
}

test("지표·열 연결은 실패 후 입력을 보존하고 저장·근거 행·새로고침·열 제거에 반영된다", async ({page}) => {
  const {base} = await setup(page);
  const editor = page.getByRole("group", {name: "모니터링 지표·열 연결", exact: true});
  await editor.getByRole("checkbox", {name: /A열 지표 연결/}).check();
  await editor.getByRole("combobox", {name: "A열 지표 종류", exact: true}).selectOption("attendance");
  await editor.getByLabel("A열 지표 이름", {exact: true}).fill("<가상 출석 기록>");
  await editor.getByLabel("A열 표시 단위 · 선택", {exact: true}).fill("%");
  await expect(page.getByRole("region", {name: "자료 근거 행 확인", exact: true})).toHaveCount(0);
  let fail = true;
  await page.route("**" + base + "/selection", async (route) => { if (route.request().method() === "PUT" && fail) {fail = false; await route.abort();} else await route.continue(); });
  const save = page.getByRole("button", {name: "열 선택 저장", exact: true});
  await save.click(); await expect(page.getByRole("region", {name: "파일 내용 미리보기·열 선택", exact: true}).getByRole("alert")).toBeVisible();
  await expect(editor.getByLabel("A열 지표 이름", {exact: true})).toHaveValue("<가상 출석 기록>");
  await save.click();
  const evidence = page.getByRole("region", {name: "자료 근거 행 확인", exact: true});
  await evidence.getByRole("button", {name: "자료 행 확인", exact: true}).click();
  const result = evidence.getByRole("region", {name: "조회한 근거 행", exact: true});
  await expect(result).toContainText("출석 자료 · <가상 출석 기록> · 표시 단위 %");
  await expect(result.locator("dd").first()).toHaveText("90");
  await page.reload(); await page.getByRole("button", {name: "가상 지표.csv 미리보기", exact: true}).click();
  await expect(editor.getByLabel("A열 지표 이름", {exact: true})).toHaveValue("<가상 출석 기록>");
  await page.locator(".column-choices input[type=checkbox]").first().uncheck();
  await expect(editor.getByLabel("A열 지표 이름", {exact: true})).toHaveCount(0); await save.click();
  const stored = await (await page.request.get(base + "/preview")).json(); expect(stored.selection.monitoring).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("지표 버전 충돌은 편집을 유지하고 잘못된 연결 응답은 표시하지 않는다", async ({page}) => {
  const {base, settings} = await setup(page);
  const editor = page.getByRole("group", {name: "모니터링 지표·열 연결", exact: true});
  await editor.getByRole("checkbox", {name: /A열 지표 연결/}).check(); await editor.getByLabel("A열 지표 이름", {exact: true}).fill("가상 미저장 지표");
  const monitoring = [{index: 0, metric: "progress", label: "가상 서버 지표", unit: "%"}];
  expect((await page.request.put(base + "/selection", {headers: {"X-Office-Request": "1"}, data: {...settings, revision: 1, monitoring}})).status()).toBe(200);
  await page.getByRole("button", {name: "열 선택 저장", exact: true}).click();
  await expect(page.getByRole("region", {name: "파일 내용 미리보기·열 선택", exact: true}).getByRole("alert")).toContainText("다른 화면");
  await expect(editor.getByLabel("A열 지표 이름", {exact: true})).toHaveValue("가상 미저장 지표");
  await page.getByRole("button", {name: "저장 상태 다시 불러오기", exact: true}).click();
  await expect(editor.getByLabel("A열 지표 이름", {exact: true})).toHaveValue("가상 서버 지표");
  await page.route("**/evidence?*", async (route) => {
    const response = await route.fetch(), value = await response.json(); value.evidence.cells[0].mapping.unit = "회";
    await route.fulfill({response, json: value});
  });
  const evidence = page.getByRole("region", {name: "자료 근거 행 확인", exact: true});
  await evidence.getByRole("button", {name: "자료 행 확인", exact: true}).click();
  await expect(evidence.getByRole("alert")).toContainText("응답을 확인하지 못했습니다");
  await expect(evidence.getByRole("region", {name: "조회한 근거 행", exact: true})).toHaveCount(0);
  await page.unroute("**/evidence?*"); await evidence.getByRole("button", {name: "자료 행 확인", exact: true}).click();
  await expect(evidence.getByRole("region", {name: "조회한 근거 행", exact: true})).toContainText("가상 서버 지표");
});
