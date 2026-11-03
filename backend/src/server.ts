import { loadAiRuntime } from "./aiRuntime.ts";
import { createAiQueue } from "./aiQueue.ts";
import { attachJobUpdates } from "./jobUpdates.ts";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createSummaryQueue } from "./summaryQueue.ts";
import { createApp } from "./app.ts";
import { createStore } from "./store.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT는 1~65535의 정수여야 합니다.");
let runtime: Awaited<ReturnType<typeof loadAiRuntime>>;
try { runtime = await loadAiRuntime(process.env.OFFICE_AI_RUNTIME_CONFIG); }
catch {
  console.error("AI 운영 설정 오류: 비공개 설정·제품 키·호출 검증·허용 계정을 확인하세요. 서버는 시작하지 않았습니다.");
  process.exit(1);
}
const store = createStore(
  resolve(root, process.env.OFFICE_DB_PATH ?? "database/office.sqlite"),
  resolve(root, process.env.OFFICE_INPUT_DIR ?? "storage/input/jobs"),
  resolve(root, process.env.OFFICE_OUTPUT_DIR ?? "storage/output/runs"),
);
const aiQueue = createAiQueue(store, runtime?.registration, { allowedAccounts: runtime?.allowedAccountIds });
const app = createApp(store, {
  frontendDir: resolve(root, "frontend/dist"),
  aiConfig: runtime?.registration.config,
  aiAllowedAccounts: runtime?.allowedAccountIds,
  secureCookies: process.env.NODE_ENV === "production",
});
const queue = createSummaryQueue(store);
const server = app.listen(port, process.env.HOST ?? "127.0.0.1", () => {
  queue.start();
  aiQueue.start();
  console.log(`교육운영 업무 서버 시작 · 포트 ${port} · ${runtime ? "AI 허용 계정 접수 설정 · 연결 성공 미검증" : "AI 실행 미연결"}`);
});
const updates = attachJobUpdates(server, store);
let stopping = false;
async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  updates.close();
  const httpClosed = new Promise<void>((done) => server.close(() => done()));
  await aiQueue.stop();
  await queue.stop();
  await httpClosed;
  store.close();
  process.exit(exitCode);
}
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
server.on("error", () => {
  console.error("서버 시작 또는 실행 오류: 서버를 종료합니다.");
  void stop(1);
});
