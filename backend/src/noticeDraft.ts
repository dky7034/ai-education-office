export interface NoticeInput {
  format: "notice" | "email";
  purpose: string;
  audience: string;
  keyPoints: string;
  notes: string;
}
export class NoticeError extends Error {}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function normalizeNotice(value: unknown): NoticeInput {
  if (!object(value) || Object.keys(value).some((key) => !["format", "purpose", "audience", "keyPoints", "notes"].includes(key))
    || !["notice", "email"].includes(value.format as string)) throw new NoticeError("공지 형식·목적·대상·핵심 내용을 확인해 주세요.");
  const read = (key: string, max: number, multiline = false, optional = false) => {
    const raw = value[key] === undefined && optional ? "" : value[key];
    if (typeof raw !== "string") throw new NoticeError("공지 입력은 문자열이어야 합니다.");
    const text = raw.replace(/\r\n?/g, "\n").trim();
    if ((!optional && !text) || text.length > max || /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(text)
      || (!multiline && /[\n\t]/.test(text))) throw new NoticeError("목적·대상은 한 줄 300자, 핵심 내용은 2,000자, 메모는 1,000자 이내로 입력해 주세요. 제어 문자는 사용할 수 없습니다.");
    return text;
  };
  return { format: value.format as NoticeInput["format"], purpose: read("purpose", 300), audience: read("audience", 300),
    keyPoints: read("keyPoints", 2000, true), notes: read("notes", 1000, true, true) };
}
export function noticeInstructions(input: NoticeInput) {
  return `공지·메일 구조화 요청\n형식: ${input.format === "notice" ? "공지" : "메일"}\n목적: ${input.purpose}\n대상: ${input.audience}\n핵심 내용:\n${input.keyPoints}${input.notes ? `\n추가 메모:\n${input.notes}` : ""}`;
}
export function noticeDraft(title: string, value: unknown, meta: { id: string; createdAt: string }) {
  const input = normalizeNotice(value);
  const heading = title.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
  const lines = [`제목: [검수 필요] ${heading}`, "", `규칙 기반 ${input.format === "notice" ? "공지" : "메일"} 초안 · AI 생성 아님 · 발송하지 않음`, "",
    input.format === "email" ? "안녕하세요." : "안내드립니다.", `대상: ${input.audience}`, `목적: ${input.purpose}`, "", "안내 내용", input.keyPoints,
    ...(input.notes ? ["", "작성자 참고 메모 (공유 전 삭제·반영 여부 확인)", input.notes] : []), "", "공유 전 검수",
    "수신자·공유 범위·개인정보·사실·일시·장소·연락 방법을 직접 확인하고 문구를 수정하세요. 입력하지 않은 정보는 보충하지 않았습니다.",
    "이 파일은 저장된 입력으로 만든 초안이며 승인·발송 기록이 아닙니다.", "", `업무 ${meta.id} · 저장 시각 ${meta.createdAt}`, ""];
  const bytes = Buffer.from("\ufeff" + lines.join("\n").replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"));
  if (bytes.length > 32 * 1024) throw new NoticeError("공지 초안이 출력 한도 32KiB를 초과했습니다.");
  return bytes;
}
export const NOTICE_SCHEMA = `BEGIN IMMEDIATE; ALTER TABLE jobs ADD COLUMN notice_json TEXT DEFAULT NULL; PRAGMA user_version=12; COMMIT;`;
