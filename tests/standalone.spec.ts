import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

for (const mode of ["document", "sandbox"] as const) {
  test(`단일 HTML 미리보기: ${mode}에서 외부 요청 없이 사무실·업무 시연 실행`, async ({
    page,
  }) => {
    const errors: string[] = [];
    const requests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) requests.push(request.url());
    });
    const artifact = resolve("preview/index.html");
    if (mode === "document")
      await page.setContent(readFileSync(artifact, "utf8"));
    else {
      // Opaque origin, no same-origin privilege, no development server.
      await page.setContent(
        '<iframe title="오피스 미리보기" sandbox="allow-scripts" style="width:100%;height:950px;border:0"></iframe>',
      );
      await page.locator("iframe").evaluate(
        (iframe, html) => {
          (iframe as HTMLIFrameElement).srcdoc = html;
        },
        readFileSync(artifact, "utf8"),
      );
    }
    const app = mode === "document" ? page : page.frameLocator("iframe");
    await expect(app.locator("canvas")).toBeVisible();
    await expect(app.getByLabel("직원 선택").getByRole("button")).toHaveCount(
      6,
    );
    await app
      .locator(".task-grid")
      .getByRole("button", { name: /교육 일정 관리/ })
      .click();
    await expect(app.getByRole("status")).toContainText("작업 구역 이동");
    await expect(app.getByRole("status")).toContainText("시연 완료", {
      timeout: 19000,
    });
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
  });
}
