import { METRICS, type MonitorMapping } from "./monitoring";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, jobsApi } from "./jobsApi";
import { parseEvidence, kinds, type Evidence } from "./rowEvidenceProtocol";
export default function RowEvidence({jobId, fileId, accountId, revision, sourceHash, headerRow, sheetId, columns, monitoring, onUnauthorized}: {
  jobId: string; fileId: string; accountId: string; revision: number; sourceHash: string; headerRow: number; sheetId: string; columns: readonly number[]; monitoring: readonly MonitorMapping[]; onUnauthorized: () => void;
}) {
  const [row, setRow] = useState(String(headerRow + 1)), [data, setData] = useState<Evidence | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function load(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const number = Number(row); if (!/^[1-9][0-9]*$/.test(row) || !Number.isInteger(number) || number <= headerRow || number > 20000) {setError("제목 다음의 자료 행 번호를 입력해 주세요."); return;}
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(""); setData(null);
    try {
      const value = await jobsApi<unknown>(`/${jobId}/attachments/${fileId}/evidence?revision=${revision}&row=${number}`, {headers: {"X-Office-Account": accountId}, signal: controller.signal});
      if (!controller.signal.aborted) setData(parseEvidence(value, jobId, fileId, revision, sourceHash, number, sheetId, headerRow, columns, monitoring));
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      setError(error instanceof Error ? error.message : "자료 행을 확인하지 못했습니다.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section aria-label="자료 근거 행 확인" className="job-activity-detail">
    <h4>자료 근거 행 확인</h4>
    <p className="session-note">저장한 선택 열의 원본 값을 확인합니다. 평가·판정은 하지 않으며, 판단 근거의 충분성은 사람이 확인해야 합니다.</p>
    <form onSubmit={load} className="survey-fields" aria-label="자료 행 조회">
      <label>원본 자료 행 번호<input type="number" disabled={busy} min={headerRow + 1} max={20000} value={row} onChange={(e) => {setRow(e.target.value); setData(null); setError("");}} required /></label>
      <button className="secondary-button" disabled={busy}>{busy ? "확인 중…" : "자료 행 확인"}</button>
    </form>
    {error && <p role="alert" className="request-error">{error}</p>}
    {data && <div aria-label="조회한 근거 행" role="region">
      <p>{data.sheetName} · 원본 {data.rowNumber}행 · 저장 선택 버전 {data.revision}</p>
      {!data.rowPresent && <p>이 번호에 저장된 행 요소가 없어 빈 행으로 표시합니다.</p>}
      <dl style={{overflowWrap: "anywhere"}}>{data.cells.map((cell) => <div key={cell.index}>
        <dt>{cell.mapping && <span>{METRICS[cell.mapping.metric]} · {cell.mapping.label}{cell.mapping.unit ? ` · 표시 단위 ${cell.mapping.unit}` : ""}<br/></span>}{cell.letter}{data.rowNumber} · {cell.label} · {kinds[cell.kind]}</dt>
        <dd style={{whiteSpace: "pre-wrap", unicodeBidi: "plaintext"}}>{cell.kind === "blank" ? "공란" : cell.value}{cell.truncated && " …[2,000자 이후 표시 생략 · 원본에서 확인]"}</dd>
      </div>)}</dl>
      <p className="session-note">원본 SHA-256: {data.sourceHash}<br/>첨부 {data.fileId} · 시트 {data.sheetId} · 제목 {data.headerRow}행<br/>조회 시점의 자료이며 변경 여부는 다시 조회해 확인하세요. CSV 행 번호는 따옴표 안 줄바꿈을 포함한 레코드 기준입니다. 수식은 계산하지 않고 날짜·서식은 변환하지 않습니다. 잘린 내용은 원본을 내려받아 확인하세요. 승인·검토 기록은 생성하지 않습니다.</p>
    </div>}
  </section>;
}
