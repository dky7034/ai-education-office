import { expect, type Page } from "@playwright/test";
// Only this test account's explicitly synthetic pending records are cancelled.
// This prevents repeated E2E runs from consuming the global pending quota.
export async function cancelSyntheticPending(page: Page, base: string) {
  const response = await page.request.get(base);
  if ([401, 404].includes(response.status())) return;
  expect(response.ok()).toBe(true);
  for (const run of (await response.json()).runs) {
    if (run.mode !== "synthetic" || !["queued", "running"].includes(run.status)) continue;
    const cancelled = await page.request.post(`${base}/${run.id}/cancel`, {
      headers: { "X-Office-Request": "1" }, data: {},
    });
    expect([200, 202]).toContain(cancelled.status());
  }
}
