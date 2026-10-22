import { CodexConnection, CodexConnectionError } from "../backend/src/codex/connection.ts";
import { isAccount } from "../backend/src/codex/executionProtocol.ts";
import { CODEX_VERSION } from "../backend/src/codex/protocol.ts";

const executable = process.env.OFFICE_CODEX_BIN;
if (!executable) {
  console.error("OFFICE_CODEX_BIN에 Codex 실행 파일의 절대 경로를 지정하세요.");
  process.exitCode = 1;
} else {
  let connection: CodexConnection | undefined;
  try {
    connection = new CodexConnection({ executable });
    await connection.start();
    const auth = await connection.request("account/read", { refreshToken: false }, isAccount);
    if (auth.account !== null) throw new CodexConnectionError("configuration");
    console.log(`Codex ${CODEX_VERSION}: 격리된 stdio 초기화·미인증 계약 통과 (AI 호출 없음)`);
  } catch (error) {
    console.error(error instanceof CodexConnectionError ? error.message : "Codex 검사 실패");
    process.exitCode = 1;
  } finally {
    try { await connection?.close(); }
    catch { console.error("Codex 임시 환경 정리 실패"); process.exitCode = 1; }
  }
}
