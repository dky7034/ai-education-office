import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
export const password = "synthetic-browser-passphrase-2026";
export const username = () =>
  "u" + randomUUID().replaceAll("-", "").slice(0, 24);
export const accountPanel = (page: Page) =>
  page.getByRole("region", { name: "계정·이력 복원" });
export async function registerViaApi(page: Page) {
  const name = username();
  const response = await page.request.post("/api/auth/register", {
    headers: { "X-Office-Request": "1" },
    data: { username: name, password },
  });
  expect(response.status()).toBe(201);
  return { username: name, password };
}
export async function signUp(page: Page, name = username()) {
  const panel = accountPanel(page);
  await panel.getByRole("button", { name: "회원가입", exact: true }).click();
  await panel.getByLabel("계정 아이디", { exact: true }).fill(name);
  await panel.getByLabel("비밀번호", { exact: true }).fill(password);
  await panel.getByRole("button", { name: "계정 만들기", exact: true }).click();
  await expect(panel.locator(".account-name")).toHaveText(name + "님");
  const recoveryCode = await panel
    .getByLabel("계정 복구 코드", { exact: true })
    .textContent();
  await panel
    .getByRole("button", { name: "복구 코드 보관 완료", exact: true })
    .click();
  return { username: name, password, recoveryCode: recoveryCode! };
}
export async function login(page: Page, name: string, secret = password) {
  const panel = accountPanel(page);
  await panel.getByRole("button", { name: "로그인", exact: true }).click();
  await panel.getByLabel("계정 아이디", { exact: true }).fill(name);
  await panel.getByLabel("비밀번호", { exact: true }).fill(secret);
  await panel.getByRole("button", { name: "로그인하기", exact: true }).click();
  await expect(panel.locator(".account-name")).toHaveText(name + "님");
}
