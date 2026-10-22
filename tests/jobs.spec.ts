import { expect, test } from "@playwright/test";
import { registerViaApi, login, accountPanel, signUp } from "./accountHelpers";

test("업무 요청 저장·선택·이벤트 이력·새로고침·다른 브라우저 복원·계정별 분리", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const account = await registerViaApi(page);
  await page.goto("/");
  const workspace = page.getByRole("region", { name: "업무 요청·저장 이력" });
  const submit = workspace.getByRole("button", {
    name: "업무 요청 저장",
    exact: true,
  });
  await expect(submit).toBeEnabled();
  await workspace
    .getByLabel("업무 종류", { exact: true })
    .selectOption("excel");
  await workspace.getByLabel(/업무 제목/).fill("가상 출결 데이터 확인 요청");
  await workspace
    .getByLabel(/요청 내용/)
    .fill(
      "합성 데이터의 누락 항목을 확인해 주세요. 실제 파일 처리는 아직 요청하지 않습니다.",
    );
  await submit.click();
  const detail = page.getByRole("region", { name: "선택한 업무 상세" });
  await expect(
    detail.getByRole("heading", { name: "가상 출결 데이터 확인 요청" }),
  ).toBeVisible();
  await expect(detail).toContainText("접수됨 · 자동 실행 미연결");
  await expect(detail).toContainText("데이터 분석가");
  await expect(detail).toContainText("업무 요청이 저장되었습니다.");
  await expect(page.locator(".phase-announcement")).toHaveText(
    "업무 선택 대기",
  );
  await expect(workspace.locator(".saved-job-list li")).toHaveCount(1);
  const selectedUrl = page.url();
  await page.reload();
  await expect(detail).toContainText("합성 데이터의 누락 항목");
  expect(page.url()).toBe(selectedUrl);
  const another = await browser.newContext();
  try {
    const otherPage = await another.newPage();
    await otherPage.goto(selectedUrl);
    await expect(
      accountPanel(otherPage).getByRole("button", {
        name: "로그인하기",
        exact: true,
      }),
    ).toBeVisible();
    await login(otherPage, account.username, account.password);
    await expect(otherPage.locator(".saved-job-detail")).toContainText(
      "합성 데이터의 누락 항목",
    );
    await accountPanel(otherPage)
      .getByRole("button", { name: "로그아웃", exact: true })
      .click();
    await signUp(otherPage);
    await otherPage.goto(selectedUrl);
    await expect(otherPage.locator(".request-history")).toContainText(
      "아직 저장한 업무가 없습니다.",
    );
    await expect(
      otherPage.getByRole("region", { name: "선택한 업무 상세" }),
    ).toContainText("업무를 찾을 수 없거나");
  } finally {
    await another.close();
  }
  expect(errors).toEqual([]);
});

test("연결 실패와 저장 응답 유실을 알리고 재시도 시 중복 저장하지 않는다", async ({
  page,
}) => {
  let offline = true;
  await page.route("**/api/jobs", async (route) => {
    if (offline && route.request().method() === "GET") await route.abort();
    else await route.continue();
  });
  const account = await registerViaApi(page);
  await page.goto("/");
  const workspace = page.getByRole("region", { name: "업무 요청·저장 이력" });
  await expect(workspace.getByRole("alert")).toBeVisible();
  await expect(
    workspace.getByRole("button", { name: "업무 요청 저장", exact: true }),
  ).toBeDisabled();
  offline = false;
  await workspace
    .getByRole("button", { name: "다시 연결", exact: true })
    .click();
  const submit = workspace.getByRole("button", {
    name: "업무 요청 저장",
    exact: true,
  });
  await expect(submit).toBeEnabled();
  await workspace.getByLabel(/업무 제목/).fill("응답 유실 재시도 검증");
  await workspace
    .getByLabel(/요청 내용/)
    .fill("네트워크 응답이 유실되어도 한 번만 저장되어야 합니다.");
  let loseResponse = true;
  await page.route("**/api/jobs", async (route) => {
    if (route.request().method() === "POST" && loseResponse) {
      loseResponse = false;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort();
    } else await route.fallback();
  });
  await submit.click();
  await expect(workspace.getByRole("alert")).toBeVisible();
  await expect(workspace.getByLabel(/업무 제목/)).toHaveValue(
    "응답 유실 재시도 검증",
  );
  await submit.click();
  await expect(
    page.getByRole("region", { name: "선택한 업무 상세" }),
  ).toContainText("응답 유실 재시도 검증");
  await expect(workspace.locator(".saved-job-list li")).toHaveCount(1);
  await expect(workspace.locator(".saved-events li")).toHaveCount(1);
});

test("업무 목록의 최근 집계·검토 현황과 결과 링크·새로고침·의견 보존·계정 격리", async ({
  page,
  browser,
}) => {
  await registerViaApi(page);
  const title = "합성 집계 현황 검증";
  const { job } = await (
    await page.request.post("/api/jobs", {
      headers: {
        "X-Office-Request": "1",
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: { kind: "survey", title, instructions: "가상 결과 검토" },
    })
  ).json();
  const { attachment } = await (
    await page.request.post(`/api/jobs/${job.id}/attachments`, {
      headers: {
        "X-Office-Request": "1",
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent("합성 현황.csv"),
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: Buffer.from("A\n1\n3\n"),
    })
  ).json();
  const base = `/api/jobs/${job.id}/attachments/${attachment.id}`;
  expect(
    (
      await page.request.put(base + "/selection", {
        headers: { "X-Office-Request": "1" },
        data: {
          sheetId: "csv",
          headerRow: 1,
          columns: [0],
          questions: [],
          revision: 0,
        },
      })
    ).status(),
  ).toBe(200);
  const { run } = await (
    await page.request.post(base + "/runs", {
      headers: {
        "X-Office-Request": "1",
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: { revision: 1 },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(base + "/runs/" + run.id)).json()).run
          .status,
    )
    .toBe("completed");
  await page.goto("/");
  const row = page.locator(`.saved-job-list > li[data-job-id="${job.id}"]`);
  await expect(row).toContainText("완료 1건");
  await expect(row).toContainText("검토 대기 1건");
  await expect(row).toContainText("승인 기록 0건");
  await row
    .getByRole("button", { name: title + " 최근 집계·검토 보기", exact: true })
    .click();
  const linked = page.getByRole("region", {
    name: "선택한 집계·검토 상세",
    exact: true,
  });
  const stored = linked.getByRole("region", {
    name: "저장된 백그라운드 집계 결과",
    exact: true,
  });
  await expect(stored.locator(".stored-row-counts dd")).toHaveText([
    "2행",
    "2행",
    "0행",
  ]);
  await expect(page).toHaveURL(
    new RegExp(`job=${job.id}.*file=${attachment.id}.*run=${run.id}`),
  );
  const review = linked.getByRole("region", {
      name: "결과물 검토",
      exact: true,
    }),
    comment = review.getByLabel("검토 의견 (선택)", { exact: true });
  await comment.fill("저장 전 합성 검토 의견");
  const refresh = page.getByRole("button", {
    name: "집계·검토 상태 새로고침",
    exact: true,
  });
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(comment).toHaveValue("저장 전 합성 검토 의견");
  let offline = true;
  await page.route("**/api/jobs", async (route) => {
    if (offline && route.request().method() === "GET") await route.abort();
    else await route.continue();
  });
  await refresh.click();
  await expect(page.locator(".request-history > .request-error")).toContainText(
    "연결",
  );
  await expect(comment).toHaveValue("저장 전 합성 검토 의견");
  offline = false;
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(comment).toHaveValue("저장 전 합성 검토 의견");
  const search = page.getByRole("form", {
    name: "업무 검색·상태 필터",
    exact: true,
  });
  await search
    .getByLabel("집계·검토 상태", { exact: true })
    .selectOption("review_pending");
  await search
    .getByRole("button", { name: "검색·필터 적용", exact: true })
    .click();
  await expect(row).toContainText("검토 대기 1건");
  await expect(comment).toHaveValue("저장 전 합성 검토 의견");
  await review
    .getByLabel("이 실행 결과와 보관 파일을 확인했습니다", { exact: true })
    .check();
  await review.getByRole("button", { name: "승인 확정", exact: true }).click();
  await expect(review.locator(".review-decision strong")).toHaveText(
    "승인 확정",
  );
  await expect(row).toHaveCount(0);
  await expect(
    page.getByText("검색·필터 조건에 맞는 업무가 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(linked).toContainText("승인 확정");
  await search
    .getByLabel("집계·검토 상태", { exact: true })
    .selectOption("approved");
  await search
    .getByRole("button", { name: "검색·필터 적용", exact: true })
    .click();
  await expect(row).toContainText("승인 기록 1건");
  await expect(row).toContainText("검토 대기 0건");
  const url = page.url();
  await page.reload();
  await expect(linked.locator(".review-decision strong")).toHaveText(
    "승인 확정",
  );
  const { run: next } = await (
    await page.request.post(base + "/runs", {
      headers: {
        "X-Office-Request": "1",
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: { revision: 1 },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(base + "/runs/" + next.id)).json()).run
          .status,
    )
    .toBe("completed");
  await refresh.click();
  await expect(row).toHaveCount(0);
  await search
    .getByLabel("집계·검토 상태", { exact: true })
    .selectOption("review_pending");
  await search
    .getByRole("button", { name: "검색·필터 적용", exact: true })
    .click();
  await expect(row).toContainText("검토 대기 1건");
  await expect(row).toContainText("승인 기록 0건");
  // Historical deep link keeps the previously approved run visible while the list shows the new run.
  await expect(linked.locator(".review-decision strong")).toHaveText(
    "승인 확정",
  );
  const { rm } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = process.env.OFFICE_E2E_DB?.endsWith("e2e-dev.sqlite")
    ? "e2e-dev"
    : "e2e";
  await rm(resolve("storage/input", directory, job.id, attachment.id));
  await page.reload();
  await expect(linked.locator(".review-decision strong")).toHaveText(
    "승인 확정",
  );
  await expect(stored.locator(".stored-row-counts dd")).toHaveText([
    "2행",
    "2행",
    "0행",
  ]);
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    await registerViaApi(other);
    await other.goto(url);
    await expect(other.locator(".request-history")).toContainText(
      "검색·필터 조건에 맞는 업무가 없습니다.",
    );
    await expect(
      other.getByRole("region", { name: "선택한 업무 상세" }),
    ).toContainText("업무를 찾을 수 없거나");
    await expect(other.locator(".stored-summary")).toHaveCount(0);
  } finally {
    await context.close();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("업무 검색·필터 URL 복원·서버 페이지·늦은 더 보기 응답 차단·빈 결과·연결 재시도", async ({
  page,
}) => {
  await registerViaApi(page);
  for (let i = 0; i < 27; i++) {
    const response = await page.request.post("/api/jobs", {
      headers: {
        "X-Office-Request": "1",
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: {
        kind: "survey",
        title: i < 23 ? `합성 검색대상 ${i}` : `합성 제외 ${i}`,
        instructions: i === 0 ? "가상 원문 100%_ 확인" : "가상 요청 내용",
      },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/?q=" + encodeURIComponent("검색대상") + "&status=none");
  const search = page.getByRole("form", {
      name: "업무 검색·상태 필터",
      exact: true,
    }),
    query = search.getByLabel("업무 검색", { exact: true }),
    status = search.getByLabel("집계·검토 상태", { exact: true }),
    apply = search.getByRole("button", { name: "검색·필터 적용", exact: true });
  const rows = page.locator(".saved-job-list > li"),
    heading = page.locator(".request-history > h3");
  await expect(heading).toHaveText("검색·필터 결과 23건");
  await expect(rows).toHaveCount(20);
  await expect(query).toHaveValue("검색대상");
  await expect(status).toHaveValue("none");
  await page.reload();
  await expect(rows).toHaveCount(20);
  await expect(query).toHaveValue("검색대상");
  let release = () => {},
    oldRequested = () => {},
    oldFinished = () => {};
  const requested = new Promise<void>((resolve) => (oldRequested = resolve)),
    finished = new Promise<void>((resolve) => (oldFinished = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  let hold = true;
  await page.route("**/api/jobs?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("q") === "연결실패") {
      await route.abort();
      return;
    }
    if (hold && url.searchParams.get("offset") === "20") {
      hold = false;
      const response = await route.fetch();
      oldRequested();
      await held;
      try {
        await route.fulfill({ response });
      } catch {
      } finally {
        oldFinished();
      }
    } else await route.continue();
  });
  await page.getByRole("button", { name: "이력 더 보기", exact: true }).click();
  await requested;
  await query.fill("제외");
  await apply.click();
  await expect(rows).toHaveCount(4);
  await expect(heading).toHaveText("검색·필터 결과 4건");
  release();
  await finished;
  await expect(rows).toHaveCount(4);
  await expect(page.locator(".saved-job-list")).not.toContainText("검색대상");
  await query.fill("100%_");
  await apply.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("검색대상 0");
  await query.fill("찾을수없는합성문구");
  await apply.click();
  await expect(rows).toHaveCount(0);
  await expect(
    page.getByText("검색·필터 조건에 맞는 업무가 없습니다.", { exact: true }),
  ).toBeVisible();
  await query.fill("연결실패");
  await apply.click();
  await expect(page.locator(".request-history > .request-error")).toContainText(
    "연결",
  );
  await expect(rows).toHaveCount(0);
  await expect(heading).toHaveText("검색·필터 결과 —건");
  const fileInput = page
    .getByRole("region", { name: "업무 첨부 파일", exact: true })
    .getByLabel("첨부할 파일", { exact: true });
  await fileInput.setInputFiles({
    name: "합성 미첨부.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("A\n1\n"),
  });
  const reconnect = page
    .locator(".request-history > .request-error")
    .getByRole("button", { name: "다시 연결", exact: true });
  await reconnect.click();
  await expect(reconnect).toBeEnabled();
  await expect(fileInput).toHaveValue(/합성 미첨부\.csv$/);
  await search
    .getByRole("button", { name: "검색·필터 초기화", exact: true })
    .click();
  await expect(rows).toHaveCount(20);
  await expect(heading).toHaveText("저장된 업무 27건");
  await expect(query).toHaveValue("");
  await expect(status).toHaveValue("all");
  expect(new URL(page.url()).searchParams.has("q")).toBe(false);
  expect(new URL(page.url()).searchParams.has("status")).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("다른 화면 변경을 자동 반영하며 검색·더 보기·업무와 첨부 입력을 유지하고 재연결한다", async ({
  page,
}) => {
  await registerViaApi(page);
  const create = async (title: string) => {
    const response = await page.request.post("/api/jobs", {
      headers: {
        "X-Office-Request": "1",
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: { kind: "survey", title, instructions: "가상 갱신 검증" },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).job;
  };
  for (let i = 0; i < 23; i++) await create(`합성 자동갱신 ${i}`);
  let disconnect = () => {};
  await page.routeWebSocket("**/api/jobs/updates?*", (ws) => {
    const server = ws.connectToServer();
    disconnect = () => {
      void server.close({ code: 1012, reason: "Synthetic reconnect" });
      void ws.close({ code: 1012, reason: "Synthetic reconnect" });
    };
  });
  await page.goto("/?q=" + encodeURIComponent("자동갱신") + "&status=none");
  const live = page.getByRole("status", {
    name: "업무 자동 갱신 상태",
    exact: true,
  });
  await expect(live).toContainText("자동 갱신 연결됨");
  await expect(live).toContainText("마지막 확인");
  const rows = page.locator(".saved-job-list > li");
  await page.getByRole("button", { name: "이력 더 보기", exact: true }).click();
  await expect(rows).toHaveCount(23);
  const detail = page.getByRole("region", {
    name: "선택한 업무 상세",
    exact: true,
  });
  const selectedTitle = await detail.locator("h3").first().textContent();
  await page.getByLabel(/업무 제목/).fill("작성 중인 합성 제목");
  await page.getByLabel(/요청 내용/).fill("작성 중인 합성 요청");
  const file = detail.getByLabel("첨부할 파일", { exact: true });
  await file.setInputFiles({
    name: "합성 대기.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("A\n1\n"),
  });
  const search = page.getByRole("form", {
    name: "업무 검색·상태 필터",
    exact: true,
  });
  await search
    .getByLabel("업무 검색", { exact: true })
    .fill("미적용 검색 초안");
  await create("합성 자동갱신 외부 접수");
  await expect(page.locator(".request-history > h3")).toHaveText(
    "검색·필터 결과 24건",
  );
  await expect(rows).toHaveCount(24);
  await expect(rows.first()).toContainText("외부 접수");
  await expect(detail.locator("h3").first()).toHaveText(selectedTitle!);
  disconnect();
  const missed = await create("합성 자동갱신 연결 복구");
  await expect(page.locator(".request-history > h3")).toHaveText(
    "검색·필터 결과 25건",
  );
  await expect(live).toContainText("자동 갱신 연결됨");
  await expect(rows.first()).toHaveAttribute("data-job-id", missed.id);
  await expect(rows).toHaveCount(25);
  await expect(page.getByLabel(/업무 제목/)).toHaveValue("작성 중인 합성 제목");
  await expect(page.getByLabel(/요청 내용/)).toHaveValue("작성 중인 합성 요청");
  await expect(file).toHaveValue(/합성 대기\.csv$/);
  await expect(search.getByLabel("업무 검색", { exact: true })).toHaveValue(
    "미적용 검색 초안",
  );
  expect(new URL(page.url()).searchParams.get("q")).toBe("자동갱신");
  expect(new URL(page.url()).searchParams.get("status")).toBe("none");
});

test("놓친 변경을 마지막 커서부터 재생하고 탭 새로고침에서도 커서를 복원한다", async ({
  page,
}) => {
  await registerViaApi(page);
  const create = async (title: string) => {
    const response = await page.request.post("/api/jobs", {
      headers: {
        "X-Office-Request": "1",
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: { kind: "survey", title, instructions: "가상 이벤트 복구" },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).job;
  };
  await create("합성 커서 기준 업무");
  const urls: string[] = [],
    ready: { cursor: string; reset: boolean }[] = [],
    replayed: number[] = [];
  let drop = false,
    dropped = 0;
  await page.routeWebSocket("**/api/jobs/updates?*", (ws) => {
    urls.push(ws.url());
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const data = JSON.parse(String(message));
      if (data.type === "ready") ready.push(data);
      if (data.type === "events") {
        if (drop) {
          drop = false;
          dropped = data.to;
          void server.close({ code: 1012, reason: "Synthetic missed event" });
          void ws.close({ code: 1012, reason: "Synthetic missed event" });
          return;
        }
        replayed.push(
          ...data.events.map((e: { sequence: number }) => e.sequence),
        );
      }
      ws.send(message);
    });
  });
  await page.goto("/");
  const live = page.getByRole("status", {
    name: "업무 자동 갱신 상태",
    exact: true,
  });
  await expect(live).toContainText("자동 갱신 연결됨");
  await expect(live).toContainText("마지막 확인");
  const first = ready[0]!.cursor;
  await page.getByLabel(/업무 제목/).fill("복구 중 유지할 합성 입력");
  drop = true;
  const missed = await create("합성 누락 이벤트 업무");
  await expect.poll(() => replayed.includes(dropped) && dropped > 0).toBe(true);
  await expect(
    page.locator(`.saved-job-list > li[data-job-id="${missed.id}"]`),
  ).toBeVisible();
  await expect(page.getByLabel(/업무 제목/)).toHaveValue(
    "복구 중 유지할 합성 입력",
  );
  expect(
    urls.some((url) => new URL(url).searchParams.get("cursor") === first),
  ).toBe(true);
  const finalCursor = first.replace(/:[0-9]+$/, ":" + dropped);
  const connections = urls.length;
  await page.reload();
  await expect(live).toContainText("자동 갱신 연결됨");
  await expect(page.locator(".saved-job-list > li")).toHaveCount(2);
  expect(
    urls
      .slice(connections)
      .some((url) => new URL(url).searchParams.get("cursor") === finalCursor),
  ).toBe(true);
  expect(ready.at(-1)!.reset).toBe(false);
  expect((await (await page.request.get("/api/jobs")).json()).page.total).toBe(
    2,
  );
});
