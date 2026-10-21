import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.ts";

test("운영 모드 쿠키에 Secure·HttpOnly·SameSite·만료 기간을 적용한다", async () => {
  const f = await fixture({ secureCookies: true });
  try {
    const a = await f.account();
    for (const attribute of [
      "Secure",
      "HttpOnly",
      "SameSite=Strict",
      "Path=/api",
      "Max-Age=604800",
    ])
      assert.equal(a.cookieAttributes.includes(attribute), true);
    const logout = await f.auth("logout", {}, a.cookie);
    assert.equal(
      logout.headers
        .getSetCookie()
        .some((value) => value.startsWith("office_auth=;")),
      true,
    );
    assert.equal((await f.get("/api/jobs", a.cookie)).status, 401);
  } finally {
    await f.cleanup();
  }
});
