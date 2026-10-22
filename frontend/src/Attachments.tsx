import BackgroundSummary from "./BackgroundSummary";
import { useEffect, useRef, useState, type FormEvent } from "react";
import FilePreview from "./FilePreview";
import { jobsApi, ApiError } from "./jobsApi";
interface Attachment {
  id: string;
  jobId: string;
  name: string;
  size: number;
  sha256: string;
  format: string;
  createdAt: string;
}
export default function Attachments({
  jobId,
  accountId,
  onUnauthorized,
  target,
  onActivityChange,
}: {
  jobId: string;
  accountId: string;
  onUnauthorized: () => void;
  target?: { fileId: string; runId: string } | null;
  onActivityChange?: () => void;
}) {
  const [targetRun, setTargetRun] = useState<{
    fileId: string;
    runId: string;
  } | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);
  const alive = useRef(true),
    key = useRef<string | null>(null),
    input = useRef<HTMLInputElement>(null);
  const linked = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (targetRun) {
      linked.current?.focus({ preventScroll: true });
      linked.current?.scrollIntoView({ block: "start" });
    }
  }, [targetRun?.fileId, targetRun?.runId]);
  const abort = useRef(new AbortController());
  const headers = { "X-Office-Account": accountId };
  function fail(e: unknown) {
    if (!alive.current) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    setError(
      e instanceof Error ? e.message : "파일 요청을 처리하지 못했습니다.",
    );
  }
  useEffect(() => {
    alive.current = true;
    abort.current = new AbortController();
    return () => {
      alive.current = false;
      abort.current.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    jobsApi<{ attachments: Attachment[] }>(`/${jobId}/attachments`, {
      headers,
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setFiles(data.attachments);
      })
      .catch((e) => {
        if (!controller.signal.aborted) fail(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [jobId, accountId, version]);
  useEffect(() => {
    if (!target) {
      setTargetRun(null);
      return;
    }
    if (loading) return;
    setPreviewId(null);
    if (files.some((file) => file.id === target.fileId)) {
      setTargetRun(target);
      setError("");
    } else {
      setTargetRun(null);
      setError(
        "연결된 첨부 파일을 찾을 수 없습니다. 업무와 파일을 다시 확인해 주세요.",
      );
    }
  }, [target?.fileId, target?.runId, loading, files]);
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || busy) return;
    setError("");
    setNotice("");
    if (
      !/\.(csv|xlsx)$/i.test(file.name) ||
      !file.size ||
      file.size > 5 * 1024 * 1024
    ) {
      setError(
        "빈 파일을 제외한 XLSX·CSV 파일을 선택해 주세요. 파일당 최대 5MiB입니다.",
      );
      return;
    }
    setBusy(true);
    key.current ??= `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    try {
      await jobsApi(`/${jobId}/attachments`, {
        method: "POST",
        signal: abort.current.signal,
        headers: {
          ...headers,
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
          "Idempotency-Key": key.current,
        },
        body: file,
      });
      if (!alive.current) return;
      key.current = null;
      setFile(null);
      if (input.current) input.current.value = "";
      setNotice(
        "원본 파일을 보관했습니다. 파일 분석은 아직 실행되지 않습니다.",
      );
      setVersion((v) => v + 1);
    } catch (e) {
      fail(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function download(item: Attachment) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/jobs/${jobId}/attachments/${item.id}`,
        { credentials: "same-origin", headers, signal: abort.current.signal },
      );
      if (!response.ok) {
        const data = await response.json();
        throw new ApiError(data.error, response.status);
      }
      const blob = await response.blob();
      if (!alive.current) return;
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = item.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      fail(
        e instanceof ApiError
          ? e
          : new Error(
              "파일을 내려받지 못했습니다. 연결을 확인하고 다시 시도해 주세요.",
            ),
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="attachments" aria-label="업무 첨부 파일">
      <h4>첨부 파일 · {files.length}/5개</h4>
      <p className="session-note">
        XLSX·UTF-8 CSV · 파일당 최대 5MiB · 원본 보관·미리보기·열 선택을
        지원합니다.
      </p>
      <form onSubmit={upload}>
        <label htmlFor={`file-${jobId}`}>첨부할 파일</label>
        <input
          ref={input}
          id={`file-${jobId}`}
          type="file"
          accept=".csv,.xlsx"
          disabled={busy || loading || files.length >= 5}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            key.current = null;
            setError("");
            setNotice("");
          }}
        />
        <button
          className="secondary-button"
          disabled={busy || loading || !file || files.length >= 5}
          type="submit"
        >
          {busy ? "파일 처리 중…" : "파일 첨부"}
        </button>
      </form>
      {loading && <p role="status">첨부 목록을 불러오는 중입니다.</p>}
      {error && (
        <p className="request-error" role="alert">
          {error}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              setError("");
              setVersion((v) => v + 1);
            }}
          >
            목록 다시 불러오기
          </button>
        </p>
      )}
      {notice && (
        <p className="request-success" role="status">
          {notice}
        </p>
      )}
      {!loading && !files.length && (
        <p className="session-note">보관된 첨부 파일이 없습니다.</p>
      )}
      <ul className="attachment-list">
        {files.map((item) => (
          <li key={item.id}>
            <strong>{item.name}</strong>
            <small>
              {item.size.toLocaleString("ko-KR")}바이트 ·{" "}
              {new Date(item.createdAt).toLocaleString("ko-KR")}
            </small>
            <details>
              <summary>원본 확인 정보</summary>
              <small>파일 ID: {item.id}</small>
              <small>SHA-256: {item.sha256}</small>
            </details>
            <button
              className="text-button"
              disabled={busy}
              aria-expanded={previewId === item.id}
              onClick={() => {
                setTargetRun(null);
                setPreviewId((previous) =>
                  previous === item.id ? null : item.id,
                );
              }}
            >
              {item.name} {previewId === item.id ? "미리보기 닫기" : "미리보기"}
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => download(item)}
            >
              {item.name} 다운로드
            </button>
          </li>
        ))}
      </ul>
      {targetRun && (
        <section
          ref={linked}
          tabIndex={-1}
          className="linked-summary"
          aria-label="선택한 집계·검토 상세"
        >
          <h4>
            {files.find((file) => file.id === targetRun.fileId)?.name} 집계·검토
          </h4>
          <BackgroundSummary
            key={`${targetRun.fileId}/${targetRun.runId}`}
            jobId={jobId}
            fileId={targetRun.fileId}
            accountId={accountId}
            revision={null}
            canSubmit={false}
            onUnauthorized={onUnauthorized}
            historyOnly
            initialRunId={targetRun.runId}
            onActivityChange={onActivityChange}
          />
        </section>
      )}
      {previewId && (
        <FilePreview
          key={previewId}
          jobId={jobId}
          fileId={previewId}
          accountId={accountId}
          onUnauthorized={onUnauthorized}
          onActivityChange={onActivityChange}
        />
      )}
    </section>
  );
}
