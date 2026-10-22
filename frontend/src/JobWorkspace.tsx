import JobActivity from "./JobActivity";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ClipboardList, Plus, RefreshCw } from "lucide-react";
import { createStaff, TASKS, type TaskKind } from "./simulation";
import {
  jobsApi,
  ApiError,
  type JobDetail,
  type JobPage,
  type SavedJob,
} from "./jobsApi";

import Attachments from "./Attachments";

const staff = createStaff();
const date = (value: string) =>
  new Date(value).toLocaleString("ko-KR", { hour12: false });
const message = (error: unknown) =>
  error instanceof Error ? error.message : "요청 처리 중 오류가 발생했습니다.";

export default function JobWorkspace({
  accountId,
  onUnauthorized,
  refreshKey,
}: {
  accountId: string;
  onUnauthorized: () => void;
  refreshKey: number;
}) {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  async function accountApi<T>(path: string, options: RequestInit = {}) {
    try {
      return await jobsApi<T>(path, {
        ...options,
        headers: { ...options.headers, "X-Office-Account": accountId },
      });
    } catch (error) {
      if (alive.current && error instanceof ApiError && error.status === 401)
        onUnauthorized();
      throw error;
    }
  }
  const [jobs, setJobs] = useState<SavedJob[]>([]);
  const [page, setPage] = useState<JobPage["page"] | null>(null);
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("job"),
  );
  const [target, setTarget] = useState<{
    fileId: string;
    runId: string;
  } | null>(() => {
    const params = new URLSearchParams(location.search),
      fileId = params.get("file"),
      runId = params.get("run");
    return fileId && runId ? { fileId, runId } : null;
  });
  const [activityVersion, setActivityVersion] = useState(0);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [version, setVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [kind, setKind] = useState<TaskKind>("survey");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const requestKey = useRef<string | null>(null);
  const counter = useRef(0);
  const generation = useRef(0);

  useEffect(() => {
    const abort = new AbortController();
    generation.current++;
    setLoading(true);
    setMoreLoading(false);
    setError("");
    accountApi<JobPage>("", { signal: abort.signal })
      .then((data) => {
        setJobs(data.jobs);
        setPage(data.page);
        setConnected(true);
        setSelected((id) => id ?? data.jobs[0]?.id ?? null);
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(message(e));
          setConnected(false);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [version, refreshKey]);

  useEffect(() => {
    if (!selected || !connected) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    const abort = new AbortController();
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    accountApi<JobDetail>(`/${encodeURIComponent(selected)}`, {
      signal: abort.signal,
    })
      .then((data) => setDetail(data))
      .catch((e) => {
        if (!abort.signal.aborted) setDetailError(message(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setDetailLoading(false);
      });
    return () => abort.abort();
  }, [selected, connected, version, refreshKey]);

  useEffect(() => {
    if (!activityVersion) return;
    const abort = new AbortController();
    generation.current++;
    setLoading(true);
    setMoreLoading(false);
    Promise.all([
      accountApi<JobPage>("", { signal: abort.signal }),
      selected
        ? accountApi<JobDetail>(`/${encodeURIComponent(selected)}`, {
            signal: abort.signal,
          })
        : Promise.resolve(null),
    ])
      .then(([data, current]) => {
        if (abort.signal.aborted) return;
        setJobs(data.jobs);
        setPage(data.page);
        setConnected(true);
        setError("");
        if (current) setDetail(current);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [activityVersion, selected, version, refreshKey, accountId]);

  function select(
    id: string,
    nextTarget: { fileId: string; runId: string } | null = null,
  ) {
    setSelected(id);
    setTarget(nextTarget);
    const url = new URL(location.href);
    url.searchParams.set("job", id);
    if (nextTarget) {
      url.searchParams.set("file", nextTarget.fileId);
      url.searchParams.set("run", nextTarget.runId);
    } else {
      url.searchParams.delete("file");
      url.searchParams.delete("run");
    }
    history.replaceState(null, "", url);
  }
  function edited() {
    requestKey.current = null;
    setFormError("");
    setNotice("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !connected || loading) return;
    if (title.trim().length < 2 || !instructions.trim()) {
      setFormError("제목은 2자 이상, 요청 내용은 1자 이상 입력해 주세요.");
      return;
    }
    setSaving(true);
    setFormError("");
    setNotice("");
    requestKey.current ??= `request-${Date.now().toString(36)}-${++counter.current}`;
    try {
      const result = await accountApi<{ job: SavedJob; replayed: boolean }>(
        "",
        {
          method: "POST",
          headers: { "Idempotency-Key": requestKey.current },
          body: JSON.stringify({ kind, title, instructions }),
        },
      );
      if (!alive.current) return;
      select(result.job.id);
      setTitle("");
      setInstructions("");
      requestKey.current = null;
      setNotice(
        "업무 요청을 저장했습니다. 자동 실행은 아직 연결되지 않았습니다.",
      );
      setVersion((v) => v + 1);
    } catch (e) {
      if (alive.current) setFormError(message(e));
    } finally {
      if (alive.current) setSaving(false);
    }
  }
  async function more() {
    if (!page || moreLoading || loading) return;
    const current = generation.current;
    setMoreLoading(true);
    setError("");
    try {
      const result = await accountApi<JobPage>(`?offset=${jobs.length}`);
      if (current !== generation.current) return;
      setJobs((previous) => [
        ...previous,
        ...result.jobs.filter(
          (job) => !previous.some((old) => old.id === job.id),
        ),
      ]);
      setPage(result.page);
    } catch (e) {
      if (current === generation.current) setError(message(e));
    } finally {
      if (current === generation.current) setMoreLoading(false);
    }
  }

  return (
    <section
      className="card saved-workspace"
      id="saved-jobs"
      aria-labelledby="saved-jobs-title"
    >
      <div className="card-heading">
        <div>
          <h2 id="saved-jobs-title">
            <ClipboardList size={17} />
            업무 요청·저장 이력
          </h2>
          <p>요청을 서버에 보관합니다. 오피스 시뮬레이션과 별도로 관리해요.</p>
        </div>
        <button
          className="text-button"
          disabled={loading || saving}
          onClick={() => setVersion((v) => v + 1)}
        >
          <RefreshCw size={14} />
          이력 새로고침
        </button>
      </div>
      <div className="request-disclaimer">
        <strong>접수·보관 단계</strong>
        <span>
          업무를 저장해도 AI가 실행되거나 직원이 움직이지 않습니다. 첨부 파일은
          원본으로 보관합니다. 파일별 정량 집계·결과 검토는 별도로 접수하고
          확인합니다.
        </span>
      </div>
      <div className="requests-grid">
        <form
          className="request-form"
          onSubmit={submit}
          aria-label="새 업무 요청"
        >
          <h3>
            <Plus size={16} />새 업무 요청
          </h3>
          <fieldset disabled={!connected || loading || saving}>
            <label htmlFor="request-kind">업무 종류</label>
            <select
              id="request-kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as TaskKind);
                edited();
              }}
            >
              {TASKS.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
            <label htmlFor="request-title">
              업무 제목 <span>필수 · 2~100자</span>
            </label>
            <input
              id="request-title"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                edited();
              }}
              required
              minLength={2}
              maxLength={100}
              placeholder="예: 가상 교육 과정 설문 집계 요청"
              autoComplete="off"
            />
            <label htmlFor="request-instructions">
              요청 내용 <span>필수 · 최대 5,000자</span>
            </label>
            <textarea
              id="request-instructions"
              value={instructions}
              onChange={(e) => {
                setInstructions(e.target.value);
                edited();
              }}
              required
              maxLength={5000}
              rows={5}
              placeholder="목적, 확인할 내용, 원하는 결과를 적어 주세요. 실제 개인정보·비밀 값은 입력하지 마세요."
            />
            <p className="input-count">
              {instructions.length.toLocaleString("ko-KR")} / 5,000자
            </p>
            <button className="primary-button" type="submit">
              {saving ? "저장 중…" : "업무 요청 저장"}
              <ArrowRight size={14} />
            </button>
          </fieldset>
          {formError && (
            <p className="request-error" role="alert">
              {formError}
            </p>
          )}
          {notice && (
            <p className="request-success" role="status">
              {notice}
            </p>
          )}
          <p className="session-note">
            로그인한 계정에 요청을 저장합니다. 다른 브라우저에서도 같은 계정으로
            로그인하면 이력을 확인할 수 있습니다. 요청 내용에 실제 개인정보를
            입력하지 마세요.
          </p>
        </form>
        <div className="request-history" aria-label="저장된 업무 이력">
          <h3>
            저장된 업무 <span>{page?.total ?? 0}건</span>
          </h3>
          {loading && (
            <p className="request-empty" role="status">
              업무 이력을 불러오는 중입니다.
            </p>
          )}
          {error && (
            <p className="request-error" role="alert">
              {error}
              <button
                className="text-button"
                disabled={loading}
                onClick={() =>
                  activityVersion
                    ? setActivityVersion((v) => v + 1)
                    : setVersion((v) => v + 1)
                }
              >
                다시 연결
              </button>
            </p>
          )}
          {!loading && connected && jobs.length === 0 && (
            <p className="request-empty">
              아직 저장한 업무가 없습니다. 새 업무 요청을 작성해 보세요.
            </p>
          )}
          <button
            className="text-button"
            disabled={loading || saving || moreLoading}
            onClick={() => setActivityVersion((v) => v + 1)}
          >
            집계·검토 상태 새로고침
          </button>
          <p className="session-note">
            진행 중 전체 건수와 첨부별 최근 실행의 검토 기록입니다. 상태
            새로고침은 열어 둔 결과·검토 의견을 유지합니다.
          </p>
          <ul className="saved-job-list">
            {jobs.map((job) => (
              <li key={job.id} data-job-id={job.id}>
                <button
                  aria-pressed={selected === job.id}
                  onClick={() => select(job.id)}
                >
                  <span className="saved-job-heading">
                    <strong>{job.title}</strong>
                    <span>접수됨</span>
                  </span>
                  <small>
                    {TASKS.find((task) => task.id === job.kind)?.title} ·{" "}
                    {date(job.createdAt)}
                  </small>
                  <JobActivity activity={job.activity} compact />
                </button>
                {!!job.activity?.latest.length && (
                  <button
                    className="text-button activity-open"
                    onClick={() =>
                      select(job.id, {
                        fileId: job.activity!.latest[0]!.fileId,
                        runId: job.activity!.latest[0]!.runId,
                      })
                    }
                  >
                    {job.title} 최근 집계·검토 보기
                  </button>
                )}
              </li>
            ))}
          </ul>
          {page?.hasMore && (
            <button
              className="secondary-button more-jobs"
              disabled={loading || moreLoading}
              onClick={more}
            >
              {moreLoading ? "불러오는 중…" : "이력 더 보기"}
            </button>
          )}
          {selected && (
            <section className="saved-job-detail" aria-label="선택한 업무 상세">
              {detailLoading && (
                <p className="request-empty">상세 내용을 불러오는 중입니다.</p>
              )}
              {detailError && (
                <p className="request-error" role="alert">
                  {detailError}
                  <button
                    className="text-button"
                    onClick={() => setVersion((v) => v + 1)}
                  >
                    다시 불러오기
                  </button>
                </p>
              )}
              {detail && (
                <>
                  <h3>{detail.job.title}</h3>
                  <dl>
                    <dt>상태</dt>
                    <dd>
                      <strong>접수됨 · 자동 실행 미연결</strong>
                    </dd>
                    <dt>담당 역할</dt>
                    <dd>
                      {
                        staff.find(
                          (person) => person.id === detail.job.assignedStaff,
                        )?.name
                      }
                    </dd>
                    <dt>업무 ID</dt>
                    <dd>
                      <code>{detail.job.id}</code>
                    </dd>
                    <dt>접수 시각</dt>
                    <dd>{date(detail.job.createdAt)}</dd>
                    <dt>요청 내용</dt>
                    <dd className="saved-instructions">
                      {detail.job.instructions}
                    </dd>
                  </dl>
                  <section
                    className="job-activity-detail"
                    aria-label="업무 집계·검토 현황"
                  >
                    <h4>집계·검토 현황</h4>
                    <JobActivity
                      activity={
                        jobs.find((job) => job.id === detail.job.id)
                          ?.activity ?? detail.job.activity
                      }
                      onOpen={(fileId, runId) =>
                        select(detail.job.id, { fileId, runId })
                      }
                    />
                  </section>
                  <Attachments
                    key={detail.job.id}
                    target={target}
                    onActivityChange={() => setActivityVersion((v) => v + 1)}
                    jobId={detail.job.id}
                    accountId={accountId}
                    onUnauthorized={onUnauthorized}
                  />
                  <h4>저장 이벤트</h4>
                  <ol className="saved-events">
                    {detail.events.map((event) => (
                      <li key={event.id}>
                        <time>{date(event.createdAt)}</time>
                        <p>{event.message}</p>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
