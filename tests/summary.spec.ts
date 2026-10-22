import { readWorkbook } from "../backend/test/readWorkbook";
import { readFile } from "node:fs/promises";
import { csvRows } from "../backend/src/csv";
import { expect, test, type Page } from "@playwright/test";
import { registerViaApi } from "./accountHelpers";
import { xlsxFixture } from "../backend/test/xlsxFixture";
async function attach(
  page: Page,
  name: string,
  bytes: Buffer,
  columns: number[],
) {
  await registerViaApi(page);
  const created = await page.request.post("/api/jobs", {
    headers: {
      "X-Office-Request": "1",
      "Idempotency-Key": "summary-browser-job",
    },
    data: {
      kind: "survey",
      title: "합성 기초 집계 검증",
      instructions: "선택 열의 빈도만 확인합니다.",
    },
  });
  const { job } = await created.json();
  const r = await page.request.post(`/api/jobs/${job.id}/attachments`, {
    headers: {
      "X-Office-Request": "1",
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(name),
      "Idempotency-Key": "summary-browser-file",
    },
    data: bytes,
  });
  expect(r.status()).toBe(201);
  const { attachment } = await r.json();
  const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
  const saved = await page.request.put(base + "/selection", {
    headers: { "X-Office-Request": "1" },
    data: {
      sheetId: name.endsWith(".csv") ? "csv" : "0",
      headerRow: 1,
      columns,
      revision: 0,
    },
  });
  expect(saved.status()).toBe(200);
  await page.goto(`/?job=${job.id}`);
  await page
    .getByRole("button", { name: name + " 미리보기", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "선택 열 기초 집계" });
  await expect(
    panel.getByRole("button", { name: "전체 데이터 집계", exact: true }),
  ).toBeEnabled();
  return { panel, base };
}
test("CSV 전체 행 집계·네트워크 재시도·저장 버전 충돌·새로고침 재실행", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const bytes = Buffer.from(
    "A,B,C\n x ,1,\nx,01,\nX,,\n,,다른 열만\n , ,\n0,0,\n" +
      "x,1,\n".repeat(25),
  );
  const { panel, base } = await attach(page, "합성 집계.csv", bytes, [0, 1]);
  let fail = true;
  await page.route("**" + base + "/summary", async (route) => {
    if (fail) {
      fail = false;
      await route.abort();
    } else await route.continue();
  });
  const run = panel.getByRole("button", {
    name: "전체 데이터 집계",
    exact: true,
  });
  await run.click();
  await expect(panel.getByRole("alert")).toContainText("연결");
  await run.click();
  await expect(
    panel.locator(".summary-results > .summary-counts dd"),
  ).toHaveText(["31행", "29행", "2행"]);
  const a = panel.getByRole("region", { name: "A열 집계", exact: true });
  await expect(a.locator(".summary-counts dd")).toHaveText([
    "29개",
    "0개",
    "0개",
    "0개",
    "3개",
  ]);
  await expect(a.locator("tbody tr").first().getByRole("cell")).toHaveText([
    "x",
    "27",
  ]);
  await expect(
    panel
      .getByRole("region", { name: "B열 집계", exact: true })
      .locator(".summary-counts dd"),
  ).toHaveText(["28개", "1개", "0개", "0개", "3개"]);
  const saved = await page.request.put(base + "/selection", {
    headers: { "X-Office-Request": "1" },
    data: { sheetId: "csv", headerRow: 1, columns: [2], revision: 1 },
  });
  expect(saved.status()).toBe(200);
  await run.click();
  await expect(panel.getByRole("alert")).toContainText("다른 화면");
  await expect(panel.locator(".summary-results")).toHaveCount(0);
  await page
    .getByRole("button", { name: "저장 상태 다시 불러오기", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "전체 데이터 집계", exact: true })
    .click();
  await expect(
    panel.locator(".summary-results > .summary-counts dd"),
  ).toHaveText(["31행", "1행", "30행"]);
  await page.reload();
  await page
    .getByRole("button", { name: "합성 집계.csv 미리보기", exact: true })
    .click();
  await expect(panel.locator(".summary-results")).toHaveCount(0);
  await panel
    .getByRole("button", { name: "전체 데이터 집계", exact: true })
    .click();
  await expect(
    panel.locator(".summary-results > .summary-counts dd"),
  ).toHaveText(["31행", "1행", "30행"]);
  await page.getByRole("checkbox", { name: "A · A", exact: true }).check();
  await expect(panel).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("XLSX 빈 행·수식·오류 제외 건수와 값별 빈도 표시", async ({ page }) => {
  const { panel } = await attach(
    page,
    "합성 집계.xlsx",
    await xlsxFixture(),
    [0, 1, 2],
  );
  await panel
    .getByRole("button", { name: "전체 데이터 집계", exact: true })
    .click();
  await expect(
    panel.locator(".summary-results > .summary-counts dd"),
  ).toHaveText(["3행", "2행", "1행"]);
  await expect(
    panel
      .getByRole("region", { name: "B열 집계", exact: true })
      .locator(".summary-counts dd"),
  ).toHaveText(["1개", "0개", "1개", "0개", "1개"]);
  await expect(
    panel
      .getByRole("region", { name: "C열 집계", exact: true })
      .locator(".summary-counts dd"),
  ).toHaveText(["1개", "0개", "0개", "1개", "1개"]);
  await expect(
    panel.getByRole("cell", { name: "가상 의견", exact: true }),
  ).toBeVisible();
  await expect(panel).toContainText("선택 버전 1");
});

test("CSV 다운로드·연결 실패 재시도·전체 빈도·오래된 선택 차단", async ({
  page,
}) => {
  const { panel, base } = await attach(
    page,
    "합성 결과.csv",
    Buffer.from("A\n=1+1\n가상\n가상\n"),
    [0],
  );
  await panel
    .getByRole("button", { name: "전체 데이터 집계", exact: true })
    .click();
  const button = panel.getByRole("button", {
    name: "전체 빈도 CSV 다운로드",
    exact: true,
  });
  await expect(button).toBeEnabled();
  let fail = true;
  await page.route("**" + base + "/summary.csv", async (route) => {
    if (fail) {
      fail = false;
      await route.abort();
    } else await route.continue();
  });
  await button.click();
  await expect(panel.getByRole("alert")).toContainText("연결");
  const event = page.waitForEvent("download");
  await button.click();
  const download = await event;
  expect(download.suggestedFilename()).toMatch(/^office-summary-.*\.csv$/);
  const data = await readFile((await download.path())!);
  const rows = [...csvRows(data)];
  expect(
    rows.some((r) => r[0] === "값별 빈도" && r[4] === "'=1+1" && r[5] === "1"),
  ).toBeTruthy();
  expect(
    rows.some((r) => r[0] === "값별 빈도" && r[4] === "'가상" && r[5] === "2"),
  ).toBeTruthy();
  const saved = await page.request.put(base + "/selection", {
    headers: { "X-Office-Request": "1" },
    data: { sheetId: "csv", headerRow: 1, columns: [0], revision: 1 },
  });
  expect(saved.status()).toBe(200);
  await button.click();
  await expect(panel.getByRole("alert")).toContainText("다른 화면");
  await expect(panel.locator(".summary-results")).toHaveCount(0);
});

test("실제 빈도 그래프·HTML 보고서 다운로드·안전한 오프라인 표시·인쇄", async ({
  page,
  context,
}) => {
  const { panel, base } = await attach(
    page,
    "합성 보고서.csv",
    Buffer.from("A\n온라인\n온라인\n오프라인\n<script>alert(1)</script>\n"),
    [0],
  );
  await panel
    .getByRole("button", { name: "전체 데이터 집계", exact: true })
    .click();
  const chart = panel.locator(".frequency-chart");
  await expect(chart.locator("li").first()).toContainText("2건 · 50.0%");
  await expect(chart.locator(".frequency-track > div").first()).toHaveAttribute(
    "style",
    "width: 50%;",
  );
  const button = panel.getByRole("button", {
    name: "인쇄용 HTML 보고서 다운로드",
    exact: true,
  });
  await expect(button).toBeEnabled();
  const event = page.waitForEvent("download");
  await button.click();
  const download = await event;
  expect(download.suggestedFilename()).toMatch(/^office-summary-.*\.html$/);
  const html = await readFile((await download.path())!, "utf8");
  const report = await context.newPage();
  const requests: string[] = [];
  report.on("request", (r) => requests.push(r.url()));
  await report.setContent(html);
  await expect(
    report.getByRole("heading", {
      name: "선택 열 기초 집계 보고서",
      exact: true,
    }),
  ).toBeVisible();
  await expect(report.locator("main")).toContainText(
    "<script>alert(1)</script>",
  );
  await expect(report.locator("script,img,iframe")).toHaveCount(0);
  await expect(report.locator(".chart li").first()).toContainText(
    "2건 · 50.0%",
  );
  await report.setViewportSize({ width: 393, height: 852 });
  expect(
    await report.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await report.emulateMedia({ media: "print" });
  await expect(report.locator("body")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  expect(requests).toEqual([]);
  await report.close();
  await page.request.put(base + "/selection", {
    headers: { "X-Office-Request": "1" },
    data: { sheetId: "csv", headerRow: 1, columns: [0], revision: 1 },
  });
  await button.click();
  await expect(panel.getByRole("alert")).toContainText("다른 화면");
  await expect(panel.locator(".summary-results")).toHaveCount(0);
});

test("숫자 부분집합·정확한 소수 합계·빈 숫자 결과와 CSV/HTML 다운로드 일치", async ({
  page,
  context,
}) => {
  const { panel } = await attach(
    page,
    "합성 숫자.csv",
    Buffer.from(
      "수치,분류\n0.1,합성\n0.2,합성\n문자,합성\n1e100,합성\n,합성\n",
    ),
    [0, 1],
  );
  await panel
    .getByRole("button", { name: "전체 데이터 집계", exact: true })
    .click();
  const numeric = panel.getByRole("group", {
    name: "A열 숫자 집계",
    exact: true,
  });
  await expect(numeric.locator("dd")).toHaveText([
    "2개",
    "1개",
    "1개",
    "0.3",
    "0.15",
    "0.1",
    "0.2",
  ]);
  const empty = panel.getByRole("group", {
    name: "B열 숫자 집계",
    exact: true,
  });
  await expect(empty.locator("dd")).toHaveText([
    "0개",
    "5개",
    "0개",
    "—",
    "—",
    "—",
    "—",
  ]);
  await expect(empty).toContainText("숫자로 인정한 값이 없습니다.");
  for (const format of ["csv", "html"] as const) {
    const event = page.waitForEvent("download");
    await panel
      .getByRole("button", {
        name:
          format === "csv"
            ? "전체 빈도 CSV 다운로드"
            : "인쇄용 HTML 보고서 다운로드",
        exact: true,
      })
      .click();
    const data = await readFile((await (await event).path())!);
    if (format === "csv")
      expect(
        [...csvRows(data)].some(
          (r) => r[0] === "숫자 집계" && r[3] === "합계" && r[4] === "'0.3",
        ),
      ).toBe(true);
    else {
      const report = await context.newPage();
      await report.setContent(data.toString());
      await expect(
        report.locator(".numeric-summary").first().locator(".decimal"),
      ).toHaveText(["0.3", "0.15", "0.1", "0.2"]);
      await report.setViewportSize({ width: 393, height: 852 });
      expect(
        await report.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await report.close();
    }
  }
});

test("설문 척도·필수 설정 저장·복원·집계·다운로드·재시도와 충돌 복구", async ({
  page,
  context,
}) => {
  const { panel, base } = await attach(
    page,
    "합성 설문.csv",
    Buffer.from(
      "A,B,C\n1,5,\n5,,\n,3,\n6,2,\n2.5,1,\n문자,4,\n,,다른 열만\n,,\n",
    ),
    [0, 1, 2],
  );
  const a = page.getByRole("group", { name: "A열 문항 설정", exact: true }),
    b = page.getByRole("group", { name: "B열 문항 설정", exact: true });
  await a.getByRole("checkbox").first().check();
  await b.getByRole("checkbox").first().check();
  await b.getByRole("checkbox", { name: "필수 응답", exact: true }).uncheck();
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "열 선택 저장", exact: true }).click();
  await panel
    .getByRole("button", { name: "전체 데이터 집계", exact: true })
    .click();
  const survey = panel.getByRole("region", {
    name: "설문 기준 집계 결과",
    exact: true,
  });
  await expect(survey.locator(".survey-row-counts dd")).toHaveText([
    "2행",
    "5행",
  ]);
  await expect(
    survey
      .getByRole("group", { name: "A열 설문 집계", exact: true })
      .locator("dd"),
  ).toHaveText([
    "2개",
    "2개",
    "0개",
    "0개",
    "1개",
    "1개",
    "1개",
    "6",
    "3",
    "1",
    "5",
  ]);
  await page.reload();
  await page
    .getByRole("button", { name: "합성 설문.csv 미리보기", exact: true })
    .click();
  await expect(a.getByLabel("A열 척도 최댓값")).toHaveValue("5");
  await expect(
    b.getByRole("checkbox", { name: "필수 응답", exact: true }),
  ).not.toBeChecked();
  await a.getByLabel("A열 척도 최솟값").fill("8");
  await page.getByRole("button", { name: "열 선택 저장", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "파일 내용 미리보기·열 선택" })
      .getByRole("alert"),
  ).toContainText("척도");
  await a.getByLabel("A열 척도 최솟값").fill("1");
  await a.getByLabel("A열 척도 최댓값").fill("3");
  let fail = true;
  await page.route("**" + base + "/selection", async (route) => {
    if (fail) {
      fail = false;
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole("button", { name: "열 선택 저장", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "파일 내용 미리보기·열 선택" })
      .getByRole("alert"),
  ).toContainText("연결");
  await page.getByRole("button", { name: "열 선택 저장", exact: true }).click();
  await panel
    .getByRole("button", { name: "전체 데이터 집계", exact: true })
    .click();
  await expect(survey.locator(".survey-row-counts dd")).toHaveText([
    "1행",
    "6행",
  ]);
  for (const format of ["csv", "html"] as const) {
    const event = page.waitForEvent("download");
    await panel
      .getByRole("button", {
        name:
          format === "csv"
            ? "전체 빈도 CSV 다운로드"
            : "인쇄용 HTML 보고서 다운로드",
        exact: true,
      })
      .click();
    const bytes = await readFile((await (await event).path())!);
    if (format === "csv")
      expect(
        [...csvRows(bytes)].some(
          (r) =>
            r[0] === "설문 전체" && r[3] === "유효 응답 행" && r[5] === "1",
        ),
      ).toBe(true);
    else {
      const report = await context.newPage();
      await report.setContent(bytes.toString());
      await expect(
        report.getByRole("heading", {
          name: "설문 기준 집계 결과",
          exact: true,
        }),
      ).toBeVisible();
      await expect(report.locator("main")).toContainText("1~3 정수 · 필수");
      await report.setViewportSize({ width: 393, height: 852 });
      expect(
        await report.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await report.close();
    }
  }
  const external = await page.request.put(base + "/selection", {
    headers: { "X-Office-Request": "1" },
    data: {
      sheetId: "csv",
      headerRow: 1,
      columns: [0, 1, 2],
      revision: 3,
      questions: [{ index: 0, min: 1, max: 4, required: true }],
    },
  });
  expect(external.status()).toBe(200);
  await a.getByLabel("A열 척도 최댓값").fill("2");
  await page.getByRole("button", { name: "열 선택 저장", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "파일 내용 미리보기·열 선택" })
      .getByRole("alert"),
  ).toContainText("다른 화면");
  await page
    .getByRole("button", { name: "저장 상태 다시 불러오기", exact: true })
    .click();
  await expect(a.getByLabel("A열 척도 최댓값")).toHaveValue("4");
  await expect(b.getByRole("checkbox").first()).not.toBeChecked();
  await expect(panel.locator(".summary-results")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "A · A", exact: true }).uncheck();
  await expect(a).toHaveCount(0);
});

test("분석 XLSX 다운로드·전체 빈도/긴 값·설문/숫자 일치·실패 재시도·오래된 설정 차단", async ({
  page,
}) => {
  const long = "가".repeat(31999) + "😀" + "끝".repeat(1000);
  const { panel, base } = await attach(
    page,
    "합성 XLSX 결과.csv",
    Buffer.from(
      "A,B\n1,0.1\n5,0.2\n,=1+1\n,01\n," +
        long +
        "\n" +
        Array.from({ length: 40 }, (_, i) => ",합성-" + i).join("\n"),
    ),
    [0, 1],
  );
  const saved = await page.request.put(base + "/selection", {
    headers: { "X-Office-Request": "1" },
    data: {
      sheetId: "csv",
      headerRow: 1,
      columns: [0, 1],
      revision: 1,
      questions: [{ index: 0, min: 1, max: 5, required: true }],
    },
  });
  expect(saved.status()).toBe(200);
  await page
    .getByRole("button", { name: "저장 상태 다시 불러오기", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "전체 데이터 집계", exact: true })
    .click();
  await expect(
    panel
      .getByRole("group", { name: "B열 숫자 집계", exact: true })
      .locator("dd")
      .nth(3),
  ).toHaveText("1.3");
  const button = panel.getByRole("button", {
    name: "분석 결과 XLSX 다운로드",
    exact: true,
  });
  await expect(button).toBeEnabled();
  let fail = true;
  await page.route("**" + base + "/summary.xlsx", async (route) => {
    if (fail) {
      fail = false;
      await route.abort();
    } else await route.continue();
  });
  await button.click();
  await expect(panel.getByRole("alert")).toContainText("연결");
  const event = page.waitForEvent("download");
  await button.click();
  const file = await event;
  expect(file.suggestedFilename()).toMatch(/^office-summary-.*\.xlsx$/);
  const { sheets } = await readWorkbook(await readFile((await file.path())!));
  expect(sheets.map((s) => s.name)).toEqual([
    "집계 안내",
    "전체 요약",
    "열별 집계",
    "설문 문항",
    "전체 빈도",
  ]);
  expect(sheets[2]!.rows[2]!.values[10]).toBe("1.3");
  expect(sheets[3]!.rows[1]!.values[13]).toBe("3");
  expect(
    sheets[4]!.rows.some(
      (r) => r.values[3] === "=1+1" && r.types[3] === "inlineStr",
    ),
  ).toBe(true);
  expect(
    sheets[4]!.rows
      .filter((r) => r.values[7] === 2)
      .map((r) => r.values[3])
      .join(""),
  ).toBe(long);
  expect(sheets[4]!.rows.length).toBeGreaterThan(40);
  const changed = await page.request.put(base + "/selection", {
    headers: { "X-Office-Request": "1" },
    data: {
      sheetId: "csv",
      headerRow: 1,
      columns: [0, 1],
      revision: 2,
      questions: [],
    },
  });
  expect(changed.status()).toBe(200);
  await button.click();
  await expect(panel.getByRole("alert")).toContainText("다른 화면");
  await expect(panel.locator(".summary-results")).toHaveCount(0);
});

test("백그라운드 집계 응답 유실 재시도·실제 워커 완료·저장 결과·새로고침 복원", async ({
  page,
}) => {
  const { base } = await attach(
    page,
    "합성 큐.csv",
    Buffer.from("A,B\n1,0.1\n5,0.2\n6,문자\n,\n"),
    [0, 1],
  );
  const queue = page.getByRole("region", {
    name: "백그라운드 집계 작업",
    exact: true,
  });
  const button = queue.getByRole("button", {
    name: "백그라운드 집계 접수",
    exact: true,
  });
  await expect(button).toBeEnabled();
  let lose = true;
  await page.route("**" + base + "/runs", async (route) => {
    if (route.request().method() === "POST" && lose) {
      lose = false;
      const result = await route.fetch();
      expect(result.status()).toBe(202);
      await route.abort();
    } else await route.continue();
  });
  await button.click();
  await expect(queue.getByRole("alert")).toContainText("연결");
  await button.click();
  await expect(queue.locator(".summary-run-list > li")).toHaveCount(1);
  await expect(
    queue.locator(".summary-run-list > li").first().locator("strong"),
  ).toHaveText("완료");
  await queue
    .getByRole("button", { name: "저장된 집계 결과 보기", exact: true })
    .click();
  const stored = queue.getByRole("region", {
    name: "저장된 백그라운드 집계 결과",
    exact: true,
  });
  await expect(stored.locator(".stored-row-counts dd")).toHaveText([
    "4행",
    "3행",
    "1행",
  ]);
  await stored
    .locator("details")
    .filter({ hasText: "B · B 집계 결과" })
    .locator("summary")
    .click();
  await expect(stored.getByText("0.3", { exact: true })).toBeVisible();
  const files = new Map<string, Buffer>();
  async function downloadStored(format: string) {
    const pending = page.waitForEvent("download");
    await stored
      .getByRole("button", {
        name: `보관 ${format.toUpperCase()} 다운로드`,
        exact: true,
      })
      .click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(
      new RegExp(`^office-run-.*\\.${format}$`),
    );
    return readFile((await download.path())!);
  }
  for (const format of ["csv", "html", "xlsx"])
    files.set(format, await downloadStored(format));
  expect(files.get("csv")!.toString()).toContain("0.3");
  expect(files.get("html")!.toString()).toContain("0.3");
  expect((await readWorkbook(files.get("xlsx")!)).sheets).toHaveLength(5);
  let loseDownload = true;
  await page.route("**" + base + "/runs/*/artifacts/csv", async (route) => {
    if (loseDownload) {
      loseDownload = false;
      await route.abort();
    } else await route.continue();
  });
  await stored
    .getByRole("button", { name: "보관 CSV 다운로드", exact: true })
    .click();
  await expect(queue.getByRole("alert")).toContainText("연결");
  await expect(stored).toBeVisible();
  expect(await downloadStored("csv")).toEqual(files.get("csv"));
  const changed = await page.request.put(base + "/selection", {
    headers: { "X-Office-Request": "1" },
    data: {
      sheetId: "csv",
      headerRow: 1,
      columns: [1],
      questions: [],
      revision: 1,
    },
  });
  expect(changed.status()).toBe(200);
  await page.reload();
  await page
    .getByRole("button", { name: "합성 큐.csv 미리보기", exact: true })
    .click();
  await expect(queue.locator(".summary-run-list > li")).toHaveCount(1);
  await queue
    .getByRole("button", { name: "저장된 집계 결과 보기", exact: true })
    .click();
  await expect(stored.locator(".stored-row-counts dd")).toHaveText([
    "4행",
    "3행",
    "1행",
  ]);
  for (const [format, bytes] of files)
    expect(await downloadStored(format)).toEqual(bytes);
  await page.getByRole("checkbox", { name: "A · A", exact: true }).check();
  await expect(button).toBeDisabled();
  await expect(stored).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("실행 결과 승인·응답 유실 재시도·새로고침 보존·새 실행 반려와 충돌 복원", async ({
  page,
}) => {
  const { base } = await attach(
    page,
    "합성 검토.csv",
    Buffer.from("A\n1\n3\n"),
    [0],
  );
  const queue = page.getByRole("region", {
    name: "백그라운드 집계 작업",
    exact: true,
  });
  const enqueue = queue.getByRole("button", {
    name: "백그라운드 집계 접수",
    exact: true,
  });
  await enqueue.click();
  let row = queue.locator(".summary-run-list > li").first();
  await expect(row.locator("strong")).toHaveText("완료");
  await row
    .getByRole("button", { name: "저장된 집계 결과 보기", exact: true })
    .click();
  const review = page.getByRole("region", { name: "결과물 검토", exact: true });
  const approve = review.getByRole("button", {
    name: "승인 확정",
    exact: true,
  });
  await expect(approve).toBeDisabled();
  await expect(review.getByRole("form")).toBeVisible();
  await expect(review.getByRole("alert")).toHaveCount(0);
  await review
    .getByLabel("검토 의견 (선택)", { exact: true })
    .fill("합성 결과 <script>문자</script> 확인");
  await review
    .getByLabel("이 실행 결과와 보관 파일을 확인했습니다", { exact: true })
    .check();
  let lose = true;
  await page.route("**" + base + "/runs/*/review", async (route) => {
    if (route.request().method() === "POST" && lose) {
      lose = false;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort();
    } else await route.continue();
  });
  await approve.click();
  await expect(review.getByRole("alert")).toContainText("연결");
  await approve.click();
  await expect(review.locator(".review-decision strong")).toHaveText(
    "승인 확정",
  );
  await expect(review.locator(".review-comment")).toContainText(
    "<script>문자</script>",
  );
  expect(await review.locator("script").count()).toBe(0);
  await page.reload();
  await page
    .getByRole("button", { name: "합성 검토.csv 미리보기", exact: true })
    .click();
  await queue
    .locator(".summary-run-list > li")
    .first()
    .getByRole("button", { name: "저장된 집계 결과 보기", exact: true })
    .click();
  await expect(review.locator(".review-decision strong")).toHaveText(
    "승인 확정",
  );
  await expect(review.getByRole("form")).toHaveCount(0);
  await enqueue.click();
  await expect(queue.locator(".summary-run-list > li")).toHaveCount(2);
  row = queue.locator(".summary-run-list > li").first();
  await expect(row.locator("strong")).toHaveText("완료");
  await row
    .getByRole("button", { name: "저장된 집계 결과 보기", exact: true })
    .click();
  await expect(review.getByRole("form")).toBeVisible();
  await review
    .getByRole("combobox", { name: "검토 결정", exact: true })
    .selectOption("rejected");
  await review
    .getByLabel("이 실행 결과와 보관 파일을 확인했습니다", { exact: true })
    .check();
  const reject = review.getByRole("button", { name: "반려 확정", exact: true });
  await expect(reject).toBeDisabled();
  await review
    .getByLabel("검토 의견 (필수)", { exact: true })
    .fill("합성 문항 설정을 다시 확인");
  await review
    .getByLabel("이 실행 결과와 보관 파일을 확인했습니다", { exact: true })
    .check();
  // Another screen wins; the pending form must refresh to the existing decision.
  const runId = await row.getAttribute("data-run-id");
  const state = await (
    await page.request.get(base + "/runs/" + runId + "/review")
  ).json();
  expect(
    (
      await page.request.post(base + "/runs/" + runId + "/review", {
        headers: {
          "X-Office-Request": "1",
          "Idempotency-Key": crypto.randomUUID(),
        },
        data: {
          targetHash: state.targetHash,
          decision: "rejected",
          comment: "다른 화면에서 확정한 합성 반려",
        },
      })
    ).status(),
  ).toBe(201);
  await reject.click();
  await expect(review.getByRole("alert")).toContainText("이미 검토 결정");
  await expect(review.locator(".review-decision strong")).toHaveText(
    "반려 확정",
  );
  await expect(review.locator(".review-comment")).toContainText(
    "다른 화면에서 확정한 합성 반려",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("반려 사유·확인 체크 후 반려를 확정하고 보관 파일 변경 시 기존 결정 무효를 안내한다", async ({
  page,
}) => {
  const { base } = await attach(
    page,
    "합성 반려.csv",
    Buffer.from("A\n2\n4\n"),
    [0],
  );
  const queue = page.getByRole("region", {
    name: "백그라운드 집계 작업",
    exact: true,
  });
  await queue
    .getByRole("button", { name: "백그라운드 집계 접수", exact: true })
    .click();
  const row = queue.locator(".summary-run-list > li").first();
  await expect(row.locator("strong")).toHaveText("완료");
  await row
    .getByRole("button", { name: "저장된 집계 결과 보기", exact: true })
    .click();
  const review = page.getByRole("region", { name: "결과물 검토", exact: true });
  await expect(review.getByRole("form")).toBeVisible();
  let staleTarget = true;
  await page.route("**" + base + "/runs/*/review", async (route) => {
    if (route.request().method() === "GET" && staleTarget) {
      staleTarget = false;
      const response = await route.fetch();
      const value = await response.json();
      await route.fulfill({
        response,
        json: { ...value, targetHash: "0".repeat(64) },
      });
    } else await route.continue();
  });
  await review
    .getByRole("button", { name: "검토 상태 새로고침", exact: true })
    .click();
  await expect(
    review.getByText("표시 중인 결과가 변경되었습니다.", { exact: false }),
  ).toBeVisible();
  await expect(review.getByRole("form")).toHaveCount(0);
  await review
    .getByRole("button", { name: "검토 상태 새로고침", exact: true })
    .click();
  await expect(review.getByRole("form")).toBeVisible();
  await review
    .getByRole("combobox", { name: "검토 결정", exact: true })
    .selectOption("rejected");
  await review
    .getByLabel("검토 의견 (필수)", { exact: true })
    .fill("합성 문항 범위 재검토");
  await review
    .getByLabel("이 실행 결과와 보관 파일을 확인했습니다", { exact: true })
    .check();
  await review.getByRole("button", { name: "반려 확정", exact: true }).click();
  await expect(review.locator(".review-decision strong")).toHaveText(
    "반려 확정",
  );
  await expect(review.locator(".review-comment")).toContainText(
    "합성 문항 범위 재검토",
  );
  const runId = (await row.getAttribute("data-run-id"))!;
  // Only this synthetic run's generated file in the isolated browser output root.
  const { writeFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = process.env.OFFICE_E2E_DB?.endsWith("e2e-dev.sqlite")
    ? "e2e-dev"
    : "e2e";
  await writeFile(
    resolve("storage/output", directory, runId, "summary.csv"),
    "합성 변조",
  );
  await review
    .getByRole("button", { name: "검토 상태 새로고침", exact: true })
    .click();
  await expect(review.getByRole("alert")).toContainText(
    "기존 결정이 현재 파일에 유효하지 않습니다",
  );
  await expect(review.locator(".review-decision strong")).toHaveText(
    "반려 확정",
  );
  await expect(review.getByRole("form")).toHaveCount(0);
  expect(
    (
      await page.request.get(base + "/runs/" + runId + "/artifacts/csv")
    ).status(),
  ).toBe(409);
});
