import type { AiConfig } from "../src/aiStore.ts";
import { attachJobUpdates } from "../src/jobUpdates.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.ts";
import { createStore } from "../src/store.ts";

export const testPassword = "synthetic-account-passphrase-2026";
export const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith("office_auth="))
    ?.split(";")[0] ?? "";
export async function fixture(
  options: {
    authRateLimit?: number;
    aiConfig?: AiConfig;
    secureCookies?: boolean;
    liveIntervalMs?: number;
    seed?: (filename: string) => void;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "office-accounts-"));
  const filename = join(directory, "test.sqlite");
  options.seed?.(filename);
  let store = createStore(filename);
  let server = createApp(store, options).listen(0, "127.0.0.1");
  let updates = attachJobUpdates(server, store, options.liveIntervalMs);
  await once(server, "listening");
  const url = () =>
    `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (path = "/api/jobs", value = "") =>
    fetch(url() + path, { headers: { cookie: value } });
  const auth = (
    path: string,
    body: unknown = {},
    value = "",
    extra: Record<string, string> = {},
  ) =>
    fetch(url() + "/api/auth/" + path, {
      method: "POST",
      headers: {
        cookie: value,
        "Content-Type": "application/json",
        "X-Office-Request": "1",
        ...extra,
      },
      body: JSON.stringify(body),
    });
  const account = async (
    username = "u" + randomUUID().replaceAll("-", "").slice(0, 24),
  ) => {
    const response = await auth("register", {
      username,
      password: testPassword,
    });
    if (response.status !== 201) throw new Error("테스트 계정 생성 실패");
    const data = await response.json();
    return {
      ...data,
      username,
      password: testPassword,
      cookie: cookie(response),
      cookieAttributes: response.headers.getSetCookie()[0],
    };
  };
  const post = (
    body: unknown,
    value: string,
    key = "request-test-1",
    extra: Record<string, string> = {},
  ) =>
    fetch(url() + "/api/jobs", {
      method: "POST",
      headers: {
        cookie: value,
        "Content-Type": "application/json",
        "X-Office-Request": "1",
        "Idempotency-Key": key,
        ...extra,
      },
      body: JSON.stringify(body),
    });
  const close = async () => {
    updates.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
  };
  return {
    filename,
    url,
    postJson(
      path: string,
      body: unknown,
      value: string,
      extra: Record<string, string> = {},
    ) {
      return fetch(url() + path, {
        method: "POST",
        headers: {
          cookie: value,
          "Content-Type": "application/json",
          "X-Office-Request": "1",
          ...extra,
        },
        body: JSON.stringify(body),
      });
    },
    put(
      path: string,
      body: unknown,
      value: string,
      extra: Record<string, string> = {},
    ) {
      return fetch(url() + path, {
        method: "PUT",
        headers: {
          cookie: value,
          "Content-Type": "application/json",
          "X-Office-Request": "1",
          ...extra,
        },
        body: JSON.stringify(body),
      });
    },
    upload(
      jobId: string,
      name: string,
      body: Buffer,
      value: string,
      key = "upload-test-1",
      extra: Record<string, string> = {},
    ) {
      return fetch(url() + `/api/jobs/${jobId}/attachments`, {
        method: "POST",
        headers: {
          cookie: value,
          "Content-Type": "application/octet-stream",
          "X-Office-Request": "1",
          "X-File-Name": encodeURIComponent(name),
          "Idempotency-Key": key,
          ...extra,
        },
        body: new Uint8Array(body),
      });
    },
    get,
    post,
    auth,
    account,
    session: async () => (await account()).cookie,
    async restart() {
      await close();
      store = createStore(filename);
      server = createApp(store, options).listen(0, "127.0.0.1");
      updates = attachJobUpdates(server, store, options.liveIntervalMs);
      await once(server, "listening");
    },
    async cleanup() {
      await close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
