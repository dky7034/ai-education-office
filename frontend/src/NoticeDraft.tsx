import { useEffect, useRef, useState } from "react";
import { ApiError, type SavedJob } from "./jobsApi";
export interface NoticeInput { format: "notice" | "email"; purpose: string; audience: string; keyPoints: string; notes: string }
export const emptyNotice = (): NoticeInput => ({format: "notice", purpose: "", audience: "", keyPoints: "", notes: ""});
export function NoticeFields({value, onChange}: {value: NoticeInput; onChange: (next: NoticeInput) => void}) {
  const field = (key: keyof NoticeInput, next: string) => onChange({...value, [key]: next});
  return <div>
    <label htmlFor="notice-format">초안 형식</label>
    <select id="notice-format" value={value.format} onChange={(e) => field("format", e.target.value)}>
      <option value="notice">공지</option><option value="email">메일</option>
    </select>
    <label htmlFor="notice-purpose">작성 목적 · 필수</label>
    <input id="notice-purpose" value={value.purpose} maxLength={300} required onChange={(e) => field("purpose", e.target.value)} />
    <label htmlFor="notice-audience">안내 대상 · 필수</label>
    <input id="notice-audience" value={value.audience} maxLength={300} required onChange={(e) => field("audience", e.target.value)} placeholder="주소 대신 대상 범위를 적어 주세요." />
    <label htmlFor="notice-points">핵심 내용 · 필수</label>
    <textarea id="notice-points" value={value.keyPoints} maxLength={2000} required rows={5} onChange={(e) => field("keyPoints", e.target.value)} />
    <label htmlFor="notice-notes">작성자 참고 메모 · 선택</label>
    <textarea id="notice-notes" value={value.notes} maxLength={1000} rows={3} onChange={(e) => field("notes", e.target.value)} />
    <p className="session-note">저장 후 규칙 기반 검수용 TXT 초안을 내려받습니다. 입력한 내용만 사용하며 발송하지 않습니다. 목적·대상 각 300자, 핵심 내용 2,000자, 메모 1,000자 이내입니다.</p>
  </div>;
}
export default function NoticeDraft({job, accountId, onUnauthorized}: {job: SavedJob; accountId: string; onUnauthorized: () => void}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(true), abort = useRef(new AbortController());
  useEffect(() => { alive.current = true; abort.current = new AbortController(); return () => {alive.current = false; abort.current.abort();}; }, []);
  if (!job.notice) return null;
  const input = job.notice;
  async function download() {
    if (busy) return; setBusy(true); setError("");
    try {
      const response = await fetch(`/api/jobs/${job.id}/notice-draft`, {headers: {"X-Office-Account": accountId}, credentials: "same-origin", signal: abort.current.signal});
      if (!response.ok) throw new ApiError((await response.json()).error, response.status);
      if (!response.headers.get("content-type")?.includes("text/plain")) throw new Error("초안 응답 형식을 확인하지 못했습니다.");
      const blob = await response.blob(); if (!alive.current) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `office-notice-${job.id}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      setError(error instanceof ApiError ? error.message : "초안을 내려받지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.");
    } finally { if (alive.current) setBusy(false); }
  }
  return <section aria-label="공지·메일 검수용 초안" className="job-activity-detail">
    <h4>{input.format === "notice" ? "공지" : "메일"} 초안 입력</h4>
    <p className="session-note">규칙 기반 초안 · AI 생성 아님 · 검수 필요 · 발송하지 않습니다.</p>
    <dl style={{overflowWrap: "anywhere"}}><dt>목적</dt><dd>{input.purpose}</dd><dt>대상</dt><dd>{input.audience}</dd><dt>핵심 내용</dt><dd style={{whiteSpace: "pre-wrap", overflowWrap: "anywhere"}}>{input.keyPoints}</dd>
      {input.notes && <><dt>작성자 참고 메모</dt><dd style={{whiteSpace: "pre-wrap", overflowWrap: "anywhere"}}>{input.notes}</dd></>}</dl>
    <button className="secondary-button" disabled={busy} onClick={download}>{busy ? "초안 확인 중…" : "공지·메일 초안 TXT 다운로드"}</button>
    {error && <p role="alert" className="request-error">{error}</p>}
    <p className="session-note">수신자·사실·개인정보를 검수하고 참고 메모를 정리한 뒤 공유하세요. 다운로드는 승인·발송 기록을 만들지 않습니다.</p>
  </section>;
}
