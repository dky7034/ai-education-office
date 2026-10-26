import { randomUUID } from "node:crypto";
import { CodexExecution } from "./execution.ts";
import { loadServiceConfig, ServiceConfigError } from "./serviceConfig.ts";

export const SERVICE_CHECK_PROMPT = "이것은 가상 데이터만 사용하는 연결 점검입니다. 실제 인물·교육 기록이 아닙니다. 가상 교육 A의 응답 3개: 만족 2개, 보통 1개. 외부 도구·파일·검색 없이 이 수치만 사용해 한국어 한 문장으로 요약하세요.";
const failures = {
  config_file: "설정 파일은 현재 사용자 소유의 0600 일반 파일이어야 합니다(최대 8KiB, 심볼릭/하드 링크 불가).",
  config_schema: "설정 형식·절대 경로·모델·실행 제한을 확인하세요.",
  policy_required: "비용·데이터 전송·호스트 격리 검토를 완료하고 세 확인 항목을 true로 지정하세요.",
  key_file: "제품 키 파일은 현재 사용자 소유의 0600 일반 파일이어야 합니다(링크 불가).",
  key_format: "제품 키 형식이 올바르지 않습니다. 공백·제어 문자와 크기를 확인하세요.",
  executable: "지정한 실행 파일의 존재와 실행 권한을 확인하세요.",
};

/** Never accepts arbitrary prompt/model/key arguments and never prints generated text or remote diagnostics. */
export async function checkService(args: string[], configPath: string | undefined, signal?: AbortSignal) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--execute"))
    return { exitCode: 1, message: "사용법: OFFICE_AI_CONFIG=/절대/비공개/설정.json npm run check:ai [-- --execute]" };
  if (!configPath) return { exitCode: 1, message: "OFFICE_AI_CONFIG에 비공개 제품 설정 파일의 절대 경로를 지정하세요. 개발 인증은 사용하지 않습니다." };
  let execution: CodexExecution | undefined;
  let cancelled: (() => void) | undefined;
  try {
    const options = await loadServiceConfig(configPath);
    if (!args.length) return { exitCode: 0, message: "AI 설정 오프라인 검사 통과 · 호출 없음 · 인증/모델 접근/실행 격리 실효성은 미검증 · 서버 실행은 계속 비활성" };
    if (signal?.aborted) return { exitCode: 1, message: "AI 점검 중단 · 호출 없음" };
    execution = new CodexExecution(options);
    const jobId = `service-check-${randomUUID()}`;
    const pending = execution.run(jobId, SERVICE_CHECK_PROMPT);
    cancelled = () => execution!.cancel(jobId);
    signal?.addEventListener("abort", cancelled, { once: true });
    const result = await pending;
    if (result.status === "completed" && result.needsReview && result.text?.trim())
      return { exitCode: 0, message: "가상 데이터 단일 AI 호출 통과 · 원문 비출력 · 검수 필요 · 업무 DB 미사용 · 서버 실행은 계속 비활성" };
    return { exitCode: 1, message: `AI 단일 호출 미완료 · 상태 ${result.status} · 원격 상태 ${result.remoteStatus} · 자동 재전송 없음 · 제공자 측 사용량을 확인하세요.` };
  } catch (error) {
    return { exitCode: 1, message: error instanceof ServiceConfigError ? failures[error.code] : "AI 점검 실패 · 세부 정보 비출력 · 제공자 측 사용량을 확인한 뒤 재실행 여부를 판단하세요." };
  } finally {
    if (cancelled) signal?.removeEventListener("abort", cancelled);
    // Cleanup errors must also prevent a successful check; the CLI wrapper redacts them.
    await execution?.close();
  }
}
