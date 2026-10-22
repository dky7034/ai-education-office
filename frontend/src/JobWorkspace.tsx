import { JobUpdateRevision, useJobUpdates } from "./jobUpdates";
import JobActivity from "./JobActivity";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ClipboardList, Plus, RefreshCw } from "lucide-react";
import { createStaff, TASKS, type TaskKind } from "./simulation";
import {
  jobsApi,
  ApiError,
  JOB_FILTERS,
  jobListPath,
  type JobSearch,
  type JobFilter,
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
  const [filters, setFilters] = useState<JobSearch>(() => {
    const params = new URLSearchParams(location.search),
      status = params.get("status") ?? "all";
    return {
      q: (params.get("q") ?? "").trim(),
      status: JOB_FILTERS.some(([id]) => id === status)
        ? (status as JobFilter)
        : "all",
    };
  });
  const [searchDraft, setSearchDraft] = useState(filters.q),
    [statusDraft, setStatusDraft] = useState<JobFilter>(filters.status);
  const [loadedFilters, setLoadedFilters] = useState<JobSearch | null>(null);
  const filtersRef = useRef(filters);
  const listMatches =
    loadedFilters?.q === filters.q && loadedFilters?.status === filters.status;
  const filtered = !!filters.q || filters.status !== "all";
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

  const live = useJobUpdates(accountId);
  const [syncing, setSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  useEffect(() => {
    const abort = new AbortController();
    generation.current++;
    setLoading(true);
    setMoreLoading(false);
    setError("");
    accountApi<JobPage>(jobListPath(filters), { signal: abort.signal })
      .then((data) => {
        if (abort.signal.aborted || filtersRef.current !== filters) return;
        setLoadedFilters(filters);
        setJobs(data.jobs);
        setPage(data.page);
        setConnected(true);
        setSelected((id) => id ?? data.jobs[0]?.id ?? null);
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(message(e));
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [version, refreshKey, filters, activityVersion]);

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
    if (!activityVersion || !selected || !connected) return;
    const abort = new AbortController();
    setDetailError("");
    accountApi<JobDetail>(`/${encodeURIComponent(selected)}`, {
      signal: abort.signal,
    })
      .then((current) => {
        if (!abort.signal.aborted) setDetail(current);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setDetailError(message(e));
      });
    return () => abort.abort();
  }, [activityVersion, selected, connected, accountId]);

  // Keep visible page depth and component identity during background reads.
  useEffect(() => {
    if (!live.tick || loading || moreLoading) return;
    const abort = new AbortController();
    const current = ++generation.current;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]);
    setSyncing(true);
    const run = async () => {
      try {
        const wanted = Math.max(20, jobsRef.current.length);
        let result: JobPage;
        const all: SavedJob[] = [];
        let offset = 0;
        do {
          result = await accountApi<JobPage>(jobListPath(filters, offset), {
            signal,
          });
          all.push(
            ...result.jobs.filter(
              (job) => !all.some((old) => old.id === job.id),
            ),
          );
          offset += result.jobs.length;
        } while (result.page.hasMore && offset < wanted && result.jobs.length);
        if (abort.signal.aborted || current !== generation.current) return;
        setJobs(all);
        setPage({
          ...result.page,
          offset: 0,
          limit: all.length,
          hasMore: all.length < result.page.total,
        });
        setLoadedFilters(filters);
        setConnected(true);
        setSelected((id) => id ?? all[0]?.id ?? null);
        setError("");
        setSyncedAt(new Date().toISOString());
        if (selected) {
          try {
            const latest = await accountApi<JobDetail>(
              `/${encodeURIComponent(selected)}`,
              { signal },
            );
            if (!abort.signal.aborted && current === generation.current) {
              setDetail(latest);
              setDetailError("");
            }
          } catch (e) {
            if (!abort.signal.aborted && current === generation.current)
              setDetailError(message(e));
          }
        }
      } catch (e) {
        if (!abort.signal.aborted && current === generation.current)
          setError(message(e));
      } finally {
        if (!abort.signal.aborted) setSyncing(false);
      }
    };
    void run();
    return () => {
      abort.abort();
    };
  }, [
    live.tick,
    filters,
    loading,
    moreLoading,
    selected,
    version,
    refreshKey,
    activityVersion,
  ]);

  function applyFilters(next: JobSearch) {
    generation.current++;
    filtersRef.current = next;
    setFilters(next);
    setSearchDraft(next.q);
    setStatusDraft(next.status);
    const url = new URL(location.href);
    if (next.q) url.searchParams.set("q", next.q);
    else url.searchParams.delete("q");
    if (next.status !== "all") url.searchParams.set("status", next.status);
    else url.searchParams.delete("status");
    history.replaceState(null, "", url);
  }

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
    if (!page || moreLoading || loading || syncing || !listMatches) return;
    const current = generation.current;
    setMoreLoading(true);
    setError("");
    try {
      const result = await accountApi<JobPage>(
        jobListPath(filters, jobs.length),
      );
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
      <p
        className="session-note"
        role="status"
        aria-label="업무 자동 갱신 상태"
      >
        {live.status} ·{" "}
        {syncing
          ? "최신 상태 확인 중"
          : syncedAt
            ? `마지막 확인 ${date(syncedAt)}`
            : "최신 상태 확인 대기"}
        <button className="text-button" onClick={live.reconnect}>
          자동 갱신 다시 연결
        </button>
      </p>
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
            {filtered ? "검색·필터 결과" : "저장된 업무"}{" "}
            <span>{listMatches ? (page?.total ?? 0) : "—"}건</span>
          </h3>
          <form
            className="job-search"
            aria-label="업무 검색·상태 필터"
            onSubmit={(event) => {
              event.preventDefault();
              applyFilters({ q: searchDraft.trim(), status: statusDraft });
            }}
          >
            <label htmlFor="job-query">업무 검색</label>
            <input
              id="job-query"
              type="search"
              value={searchDraft}
              maxLength={100}
              placeholder="제목·요청 내용 검색"
              onChange={(event) => setSearchDraft(event.target.value)}
            />
            <label htmlFor="job-status-filter">집계·검토 상태</label>
            <select
              id="job-status-filter"
              value={statusDraft}
              onChange={(event) =>
                setStatusDraft(event.target.value as JobFilter)
              }
            >
              {JOB_FILTERS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <div>
              <button className="secondary-button" type="submit">
                검색·필터 적용
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => applyFilters({ q: "", status: "all" })}
              >
                검색·필터 초기화
              </button>
            </div>
          </form>
          {listMatches && filtered && (
            <p className="session-note">
              적용 조건: {loadedFilters?.q ? `“${loadedFilters.q}” · ` : ""}
              {JOB_FILTERS.find(([id]) => id === loadedFilters?.status)?.[1]} ·
              제목·요청 내용의 포함 검색입니다. 완료·검토 필터는 첨부별 최근
              실행 중 하나라도 해당하면 표시합니다.
            </p>
          )}
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
                onClick={() => setActivityVersion((v) => v + 1)}
              >
                다시 연결
              </button>
            </p>
          )}
          {!loading && connected && listMatches && jobs.length === 0 && (
            <p className="request-empty">
              {filtered
                ? "검색·필터 조건에 맞는 업무가 없습니다."
                : "아직 저장한 업무가 없습니다. 새 업무 요청을 작성해 보세요."}
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
            {(listMatches ? jobs : []).map((job) => (
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
          {listMatches && page?.hasMore && (
            <button
              className="secondary-button more-jobs"
              disabled={loading || moreLoading || syncing}
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
                  {listMatches &&
                    !loading &&
                    !jobs.some((job) => job.id === detail.job.id) && (
                      <p className="session-note">
                        선택한 업무는 현재 표시된 목록 밖에 있습니다. 열어 둔
                        상세 결과는 유지합니다.
                      </p>
                    )}
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
                  <JobUpdateRevision.Provider value={live.revision}>
                    <Attachments
                      key={detail.job.id}
                      target={target}
                      onActivityChange={() => setActivityVersion((v) => v + 1)}
                      jobId={detail.job.id}
                      accountId={accountId}
                      onUnauthorized={onUnauthorized}
                    />
                  </JobUpdateRevision.Provider>
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
