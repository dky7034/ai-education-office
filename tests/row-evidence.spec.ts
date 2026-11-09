import { expect, test } from "@playwright/test";
import { registerViaApi } from "./accountHelpers";
async function setup(page: import("@playwright/test").Page) {
  await registerViaApi(page);
  const job = (await (await page.request.post("/api/jobs", {headers: {"X-Office-Request": "1", "Idempotency-Key": "evidence-job"},
    data: {kind: "monitor", title: "가상 자료 원문 확인", instructions: "사람이 근거 확인"}})).json()).job;
  const file = (await (await page.request.post(`/api/jobs/${job.id}/attachments`, {headers: {"X-Office-Request": "1", "Content-Type": "application/octet-stream",
    "X-File-Name": encodeURIComponent("가상 근거.csv"), "Idempotency-Key": "evidence-file"},
    data: Buffer.from("구분,비선택,자료\n" + "앞,복사하지 않는 열,자료\n".repeat(22) + '끝,복사하지 않는 열,"<script>가상</script>\n두 줄"\n')})).json()).attachment;
  const base = `/api/jobs/${job.id}/attachments/${file.id}`;
  const settings = {sheetId: "csv", headerRow: 1, columns: [0, 2], revision: 0};
  expect((await page.request.put(base + "/selection", {headers: {"X-Office-Request": "1"}, data: settings})).status()).toBe(200);
  await page.goto(`/?job=${job.id}`); await page.getByRole("button", {name: "가상 근거.csv 미리보기", exact: true}).click();
  return {job, file, base, settings};
}

test("근거 행은 첫 20행 밖의 선택 열만 조회하며 실패 재시도·원문 문자·미저장 업무를 유지한다", async ({page}) => {
  await setup(page);
  const panel = page.getByRole("region", {name: "자료 근거 행 확인", exact: true});
  await page.getByLabel("업무 제목").fill("유지할 미제출 업무");
  await panel.getByLabel("원본 자료 행 번호").fill("24");
  let fail = true;
  await page.route("**/evidence?*", async (route) => { if (fail) {fail = false; await route.abort();} else await route.continue(); });
  await panel.getByRole("button", {name: "자료 행 확인", exact: true}).click(); await expect(panel.getByRole("alert")).toBeVisible();
  await expect(panel.getByLabel("원본 자료 행 번호")).toHaveValue("24");
  await panel.getByRole("button", {name: "자료 행 확인", exact: true}).click();
  const result = panel.getByRole("region", {name: "조회한 근거 행", exact: true});
  await expect(result).toContainText("원본 24행"); await expect(result).toContainText("A24"); await expect(result).toContainText("C24");
  await expect(result).toContainText("<script>가상</script>\n두 줄"); await expect(result).not.toContainText("복사하지 않는 열");
  await expect(page.getByLabel("업무 제목")).toHaveValue("유지할 미제출 업무");
  await expect(panel).toContainText("판단 근거의 충분성은 사람이 확인해야 합니다");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("근거 행은 버전 변경·잘못된 응답을 차단하고 다른 계정의 원문을 남기지 않는다", async ({page}) => {
  const {job, file, base, settings} = await setup(page);
  const panel = page.getByRole("region", {name: "자료 근거 행 확인", exact: true});
  const button = panel.getByRole("button", {name: "자료 행 확인", exact: true});
  await page.route("**/evidence?*", async (route) => {
    const response = await route.fetch(), value = await response.json();
    await route.fulfill({response, json: {...value, evidence: {...value.evidence, fileId: "wrong-file"}}});
  });
  await button.click(); await expect(panel.getByRole("alert")).toContainText("응답을 확인하지 못했습니다");
  await expect(panel.getByRole("region", {name: "조회한 근거 행", exact: true})).toHaveCount(0);
  await page.unroute("**/evidence?*");
  expect((await page.request.put(base + "/selection", {headers: {"X-Office-Request": "1"}, data: {...settings, revision: 1, columns: [0]}})).status()).toBe(200);
  await button.click(); await expect(panel.getByRole("alert")).toContainText("다른 화면");
  await page.getByRole("button", {name: "저장 상태 다시 불러오기", exact: true}).click();
  await expect(panel.getByRole("region", {name: "조회한 근거 행", exact: true})).toHaveCount(0);
  await panel.getByRole("button", {name: "자료 행 확인", exact: true}).click();
  await expect(panel.getByRole("region", {name: "조회한 근거 행", exact: true})).toContainText("A2");
  await expect(panel.getByRole("region", {name: "조회한 근거 행", exact: true})).not.toContainText("C2");
  await page.request.post("/api/auth/logout", {headers: {"X-Office-Request": "1"}, data: {}}); await registerViaApi(page); await page.goto(`/?job=${job.id}`);
  expect((await page.request.get(`${base}/evidence?revision=2&row=2`)).status()).toBe(404);
  await expect(page.getByRole("region", {name: "조회한 근거 행", exact: true})).toHaveCount(0);
});
