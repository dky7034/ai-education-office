import { checkService } from "../backend/src/codex/serviceCheck.ts";

const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  const result = await checkService(process.argv.slice(2), process.env.OFFICE_AI_CONFIG, controller.signal);
  console[result.exitCode ? "error" : "log"](result.message);
  process.exitCode = result.exitCode;
} catch {
  console.error("AI 점검 또는 임시 환경 정리 실패 · 세부 정보 비출력");
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
