import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createApp } from "./app.ts";
import { createStore } from "./store.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT는 1~65535의 정수여야 합니다.");
const store = createStore(
  resolve(root, process.env.OFFICE_DB_PATH ?? "database/office.sqlite"),
  resolve(root, process.env.OFFICE_INPUT_DIR ?? "storage/input/jobs"),
);
const app = createApp(store, {
  frontendDir: resolve(root, "frontend/dist"),
  secureCookies: process.env.NODE_ENV === "production",
});
const server = app.listen(port, process.env.HOST ?? "127.0.0.1", () =>
  console.log(`교육운영 업무 서버 시작 · 포트 ${port} · AI 실행 미연결`),
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.on("error", (error) => {
  console.error(`서버 시작 실패: ${error.message}`);
  store.close();
  process.exit(1);
});
