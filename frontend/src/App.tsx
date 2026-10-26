import AiOfficePanel from "./AiOfficePanel";
import ServerOfficePanel, { ServerOfficeRecent } from "./ServerOfficePanel";
import { serverStaff, type ServerOfficeView } from "./serverOffice";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleHelp,
  ClipboardList,
  Clock3,
  Coffee,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  History,
  LayoutDashboard,
  Leaf,
  ListChecks,
  Mail,
  Monitor,
  Pause,
  Play,
  Presentation,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import OfficeMap from "./OfficeMap";
import AccountWorkspace from "./AccountWorkspace";
import {
  PHASE_LABELS,
  TASKS,
  type StaffId,
  type TaskKind,
  type Phase,
} from "./simulation";
import { useOffice } from "./useOffice";

const icons = {
  survey: BarChart3,
  notice: Mail,
  monitor: Users,
  excel: FileSpreadsheet,
  slides: Presentation,
  schedule: CalendarDays,
};
const phaseOrder: Phase[] = [
  "assigned",
  "moving",
  "analyzing",
  "working",
  "reviewing",
  "awaiting",
  "completed",
];

export default function App() {
  const { state, running, start, reset, fail } = useOffice();
  const [serverView, setServerView] = useState<ServerOfficeView | null>(null);
  const [officeMode, setOfficeMode] = useState<"simulation" | "server">(
    "simulation",
  );
  const publishOffice = useCallback((view: ServerOfficeView | null) => {
    setServerView(view);
    if (!view) setOfficeMode("simulation");
  }, []);
  const realMode = officeMode === "server" && !!serverView;
  const people = realMode ? serverStaff(serverView!) : state.staff;
  const [selected, setSelected] = useState<StaffId>("lead");
  const [dialog, setDialog] = useState<"help" | "settings" | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const logsRef = useRef<HTMLDivElement>(null);
  const current = TASKS.find((t) => t.id === state.job?.kind);
  const person = people.find((p) => p.id === selected)!;
  const phaseIndex = state.job ? phaseOrder.indexOf(state.job.phase) : -1;
  const phaseLabel = state.job
    ? PHASE_LABELS[state.job.phase]
    : "업무 선택 대기";
  useEffect(() => {
    if (logsRef.current)
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [state.logs]);
  useEffect(() => {
    if (dialog) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [dialog]);
  function choose(kind: TaskKind) {
    if (running || realMode) return;
    setSelected(TASKS.find((t) => t.id === kind)!.staff);
    start(kind);
  }
  function clear() {
    setOfficeMode("simulation");
    reset();
    setSelected("lead");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="주 메뉴">
        <a className="brand" href="#office">
          <span className="brand-mark">
            <Leaf size={24} />
          </span>
          <span>
            모아<span className="brand-caption">AI 교육운영 오피스</span>
          </span>
        </a>
        <div className="workspace-tag">
          <span className="workspace-icon">교</span>
          <div>
            <strong>우리 교육운영팀</strong>
            <span>교육의 일상을 더 가볍게</span>
          </div>
        </div>
        <p className="nav-label">워크스페이스</p>
        <a className="nav-item nav-current" href="#office">
          <LayoutDashboard size={18} />
          오피스 대시보드
          <span className="nav-dot" />
        </a>
        {!__STANDALONE__ && (
          <a className="nav-item" href="#account">
            <ClipboardList size={18} />
            업무 요청·이력
          </a>
        )}
        <p className="nav-label task-nav-label">업무 시뮬레이션</p>
        <nav className="task-nav" aria-label="교육 운영 업무 시연">
          {TASKS.map((task) => {
            const Icon = icons[task.id];
            return (
              <button
                key={task.id}
                disabled={running || realMode}
                onClick={() => choose(task.id)}
                className={`nav-item ${current?.id === task.id ? "nav-selected" : ""}`}
              >
                <Icon size={18} />
                {task.title}
              </button>
            );
          })}
        </nav>
        <div className="nav-bottom">
          <a className="nav-item" href="#event-log">
            <History size={18} />
            시연 이벤트 로그
          </a>
          <button className="nav-item" onClick={() => setDialog("settings")}>
            <Settings2 size={18} />
            시연 설정
          </button>
        </div>
        <div className="sidebar-note">
          <span>
            <Sparkles size={16} />
            함께 일하는 작은 오피스
          </span>
          <p>
            반복되는 일은 줄이고,
            <br />
            교육에 더 집중할 수 있도록.
          </p>
          <span className="version">개발 미리보기 · 0.3</span>
        </div>
        <div className="profile">
          <div className="avatar">운</div>
          <div>
            <strong>교육 운영 담당자</strong>
            <span>
              {realMode ? "서버 집계 워크스페이스" : "시뮬레이션 워크스페이스"}
            </span>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            워크스페이스
            <ChevronRight size={14} />
            <strong>오피스 대시보드</strong>
          </div>
          <div className="header-actions">
            <button
              className="icon-button"
              aria-label="시연 설정 열기"
              onClick={() => setDialog("settings")}
            >
              <Settings2 size={17} />
            </button>
            <button className="help-button" onClick={() => setDialog("help")}>
              <CircleHelp size={17} />
              사용 안내
            </button>
          </div>
        </header>
        <main id="office">
          <div className="page-heading">
            <div>
              <div className="eyebrow">우리 팀의 오늘을 한눈에</div>
              <h1>
                교육운영 오피스<span className="beta">미리보기</span>
              </h1>
              <p>
                {realMode
                  ? "서버에 저장된 정량 집계와 AI 실행·검토 기록을 확인하세요."
                  : "업무를 선택하고, 우리 AI 직원들의 움직임을 살펴보세요."}
              </p>
            </div>
            <div className="mode-pill">
              <span className="dot amber" />
              {realMode ? <Monitor size={15} /> : <FlaskConical size={15} />}
              {realMode ? "서버 집계 현황" : "시뮬레이션 모드"}
            </div>
          </div>
          {!__STANDALONE__ && (
            <div
              className="office-mode-controls"
              role="group"
              aria-label="오피스 표시 선택"
            >
              <button
                className="secondary-button"
                aria-pressed={!realMode}
                onClick={() => setOfficeMode("simulation")}
              >
                업무 시연 보기
              </button>
              <button
                className="secondary-button"
                aria-pressed={realMode}
                disabled={!serverView}
                onClick={() => {
                  reset();
                  setOfficeMode("server");
                  setSelected("analyst");
                }}
              >
                서버 집계 보기
              </button>
              <p className="session-note">
                로그인 후 계정 전체의 정량 집계와 AI 기록을 구분해 표시합니다. 서버 보기로
                전환하면 진행 중인 시연은 초기화합니다.
              </p>
            </div>
          )}
          <div className="simulation-notice">
            <ShieldCheck size={19} />
            <p>
              {realMode ? (
                <>
                  <strong>서버에 저장된 정량 집계·AI 기록입니다.</strong> 캐릭터의
                  이동은 상태를 표현하는 읽기 전용 표시입니다. 화면 전환으로
                  집계·승인·AI 호출을 실행하지 않습니다.
                </>
              ) : (
                <>
                  <strong>오피스 캐릭터는 시뮬레이션입니다.</strong> 직원의
                  이동과 작업 상태만 시연하며, 실제 AI 호출·파일 처리·외부
                  발송은 실행하지 않습니다.
                </>
              )}
            </p>
          </div>
          <section className="overview" aria-label="오피스 요약">
            <div>
              <span className="stat-icon green">
                <Users size={20} />
              </span>
              <div>
                <span>함께하는 AI 직원</span>
                <strong>
                  6<span>명</span>
                </strong>
              </div>
              <span className="stat-tag">역할 캐릭터</span>
            </div>
            <div>
              <span className="stat-icon blue">
                <Monitor size={20} />
              </span>
              <div>
                <span>{realMode ? "진행 중 서버 집계" : "시연 중인 업무"}</span>
                <strong>
                  {realMode
                    ? serverView?.data
                      ? serverView.data.totals.queued +
                        serverView.data.totals.running
                      : "—"
                    : running
                      ? "1"
                      : "0"}
                  <span>건</span>
                </strong>
              </div>
              <span className="stat-tag">
                {realMode ? "계정 전체" : running ? "진행 중" : "대기 중"}
              </span>
            </div>
            <div>
              <span className="stat-icon peach">
                <CheckCircle2 size={20} />
              </span>
              <div>
                <span>AI 연결</span>
                <strong className="text-stat">미연결</strong>
              </div>
              <span className="stat-tag">후속 개발</span>
            </div>
          </section>

          {!__STANDALONE__ ? (
            <AccountWorkspace onOfficeChange={publishOffice} />
          ) : (
            <div className="request-preview-note">
              이 단일 HTML은 오피스 시연 전용입니다. 업무 요청·영구 저장 기능은
              백엔드와 함께 실행하는 앱에서 이용할 수 있습니다.
            </div>
          )}

          <div className="content-grid">
            <div className="center-column">
              <section className="card office-card" aria-labelledby="map-title">
                <div className="card-heading">
                  <div>
                    <h2 id="map-title">
                      <span className="dot green-dot" />
                      우리의 작은 오피스
                    </h2>
                    <p>직원을 클릭하면 담당 업무와 현재 상태를 볼 수 있어요.</p>
                  </div>
                  <span className="quiet-badge">탑다운 2D</span>
                </div>
                <OfficeMap staff={people} onSelect={setSelected} />
                <div className="map-footer">
                  <span>
                    <span className="dot green-dot" />
                    대기
                  </span>
                  <span>
                    <span className="dot amber" />
                    {realMode ? "서버 상태 표시" : "시연 진행"}
                  </span>
                  <span>
                    <span className="dot muted-dot" />
                    실제 AI 미연결
                  </span>
                  <span className="map-tip">
                    <Coffee size={14} />
                    작은 움직임, 한눈에 보는 업무
                  </span>
                </div>
                <div className="staff-strip" aria-label="직원 선택">
                  {people.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setSelected(p.id)}
                      aria-pressed={selected === p.id}
                      className={
                        selected === p.id ? "staff-chip selected" : "staff-chip"
                      }
                    >
                      <span
                        className="mini-person"
                        style={{ background: p.color }}
                      >
                        {p.short}
                      </span>
                      <span>
                        {p.name}
                        <small>{p.displayStatus ?? p.status}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <section
                className="card tasks-card"
                aria-labelledby="tasks-title"
              >
                <div className="card-heading">
                  <div>
                    <h2 id="tasks-title">어떤 업무를 시연할까요?</h2>
                    <p>
                      {realMode
                        ? "시연을 시작하려면 ‘업무 시연 보기’로 전환해 주세요."
                        : running
                          ? "현재 시연이 끝나면 다른 업무를 선택할 수 있어요."
                          : "업무를 선택하면 담당 직원에게 배정하고 이동을 시작해요."}
                    </p>
                  </div>
                  <span className="quiet-badge">6가지 업무</span>
                </div>
                <div className="task-grid">
                  {TASKS.map((task) => {
                    const Icon = icons[task.id];
                    return (
                      <button
                        className={`task-button ${current?.id === task.id ? "active" : ""}`}
                        key={task.id}
                        disabled={running || realMode}
                        onClick={() => choose(task.id)}
                      >
                        <span className={`task-icon ${task.id}`}>
                          <Icon size={20} />
                        </span>
                        <span>
                          <strong>{task.title}</strong>
                          <small>{task.description}</small>
                        </span>
                        <ArrowRight size={16} className="task-arrow" />
                      </button>
                    );
                  })}
                </div>
                <div className="task-note">
                  <FlaskConical size={14} />
                  {__STANDALONE__
                    ? "이 화면은 업무 흐름 시연입니다. 첨부 파일 보관은 서버와 함께 실행하는 앱에서 지원합니다."
                    : "아래 업무는 예시 이벤트로 재생됩니다. 원본 첨부는 로그인 후 저장된 업무 상세에서 이용하세요."}
                </div>
              </section>
            </div>

            <aside className="right-column" aria-label="직원 및 작업 현황">
              {realMode ? (
                <><ServerOfficePanel view={serverView!} /><AiOfficePanel view={serverView!} /></>
              ) : (
                <section className="card status-card">
                  <div className="card-heading">
                    <h2>
                      <ListChecks size={17} />
                      작업 현황
                    </h2>
                    <span className={`status-tag ${running ? "busy" : ""}`}>
                      {running ? "시연 중" : state.job ? phaseLabel : "대기 중"}
                    </span>
                  </div>
                  <div className="current-task">
                    <span className="section-label">현재 시뮬레이션</span>
                    <h3>{current?.title ?? "새로운 업무를 기다려요"}</h3>
                    <p>
                      {current
                        ? `${state.staff.find((p) => p.id === current.staff)!.name} 담당 · 예시 이벤트`
                        : "왼쪽 메뉴 또는 아래 업무 카드를 선택해 주세요."}
                    </p>
                  </div>
                  <div
                    className="phase-announcement"
                    role="status"
                    aria-live="polite"
                  >
                    <span
                      className={`dot ${state.job?.phase === "failed" ? "red-dot" : running ? "amber" : "green-dot"}`}
                    />
                    {phaseLabel}
                  </div>
                  <ol className="step-list">
                    {phaseOrder.map((phase, i) => (
                      <li
                        key={phase}
                        className={
                          i < phaseIndex
                            ? "done"
                            : i === phaseIndex
                              ? "current"
                              : ""
                        }
                      >
                        <span className="step-marker">
                          {i < phaseIndex ||
                          (phase === "completed" &&
                            state.job?.phase === "completed") ? (
                            <Check size={11} />
                          ) : (
                            <Circle size={7} />
                          )}
                        </span>
                        {PHASE_LABELS[phase]}
                      </li>
                    ))}
                  </ol>
                  {state.job?.phase === "failed" && (
                    <p className="error-note" role="alert">
                      오류 시연이 끝났습니다. 업무를 다시 선택해 새 시연을
                      시작할 수 있어요.
                    </p>
                  )}
                  <div className="approval-note">
                    <Pause size={14} />
                    <span>실제 승인·결과물은 아직 제공하지 않아요.</span>
                  </div>
                  {state.job && (
                    <div className="job-id">
                      시연 ID <code>{state.job.id.slice(0, 13)}</code>
                    </div>
                  )}
                </section>
              )}

              <section
                className="card person-card"
                aria-labelledby="person-title"
              >
                <div className="card-heading">
                  <h2 id="person-title">직원 살펴보기</h2>
                  <Users size={16} className="muted" />
                </div>
                <div className="person-intro">
                  <div
                    className="person-avatar"
                    style={{
                      background: `${person.color}26`,
                      color: person.color,
                    }}
                  >
                    <span
                      style={{ background: person.color }}
                      className="pixel-avatar"
                    />
                  </div>
                  <div>
                    <h3>{person.name}</h3>
                    <span>{person.room}</span>
                  </div>
                </div>
                <span className="person-status">
                  <span
                    className={`dot ${person.status === "오류 발생" ? "red-dot" : person.status === "대기 중" ? "green-dot" : "amber"}`}
                  />
                  {person.displayStatus ?? person.status}
                </span>
                <dl className="person-data">
                  <dt>담당 업무</dt>
                  <dd>{person.role}</dd>
                  <dt>현재 작업</dt>
                  <dd>{person.task ?? "배정된 업무가 없습니다."}</dd>
                  <dt>{realMode ? "최근 서버 역할 기록" : "최근 시연 이력"}</dt>
                  <dd>
                    {person.history.length ? (
                      <ul>
                        {person.history.map((entry, i) => (
                          <li key={i}>{entry}</li>
                        ))}
                      </ul>
                    ) : realMode ? (
                      "표시할 서버 역할 기록이 없습니다."
                    ) : (
                      "아직 시연 이력이 없습니다."
                    )}
                  </dd>
                </dl>
                <p className="person-footnote">
                  {realMode
                    ? "서버 기록을 표시하는 역할 캐릭터입니다. 정량 집계는 분석가, AI 텍스트 기록은 작성가에 표시합니다. 합성 기록은 작업 동작 없이 구분하며 승인·반려는 사용자가 확정합니다."
                    : "독립 AI 에이전트가 아닌 역할별 시각화 캐릭터입니다."}
                </p>
              </section>
              <div className="roadmap-note">
                <Leaf size={20} />
                <div>
                  <strong>교육에 집중하는 시간을 위해</strong>
                  <p>
                    업무 자동화는 다음 단계에서
                    <br />
                    하나씩 연결해 나갑니다.
                  </p>
                  <button onClick={() => setDialog("help")}>
                    개발 단계 알아보기
                    <ArrowRight size={13} />
                  </button>
                </div>
              </div>
            </aside>
          </div>

          {realMode ? (
            <ServerOfficeRecent view={serverView!} />
          ) : (
            <section
              id="event-log"
              className="card log-card"
              aria-labelledby="log-title"
            >
              <div className="card-heading">
                <div className="log-heading">
                  <h2 id="log-title">
                    <ClipboardList size={17} />
                    작업 이벤트 로그
                  </h2>
                  <span className="quiet-badge">
                    예시 이벤트 · {state.logs.length}개
                  </span>
                </div>
                <button className="text-button" onClick={clear}>
                  <RotateCcw size={14} />
                  시연 초기화
                </button>
              </div>
              <div
                className="logs"
                ref={logsRef}
                tabIndex={0}
                aria-label="시뮬레이션 이벤트 내역"
              >
                {state.logs.map((log) => (
                  <div className={`log-line ${log.level}`} key={log.id}>
                    <time>{log.time}</time>
                    <span className="log-kind">
                      {log.level === "error"
                        ? "오류 시연"
                        : log.level === "success"
                          ? "시연 완료"
                          : "시뮬레이션"}
                    </span>
                    <p>{log.text}</p>
                  </div>
                ))}
              </div>
              <div className="log-footer">
                <span>
                  <Clock3 size={12} />
                  현재 브라우저 세션에만 보관됩니다. 새로고침하면 초기화됩니다.
                </span>
                <span>실제 실행 로그 아님</span>
              </div>
            </section>
          )}
          <footer className="page-footer">
            <span>모아 · AI 교육운영 오피스</span>
            <span>
              Phase 3 업무 접수·보관 개발 중 · 실제 개인정보를 입력하지 마세요.
            </span>
          </footer>
        </main>
      </div>

      <dialog
        ref={dialogRef}
        onCancel={() => setDialog(null)}
        onClose={() => setDialog(null)}
        className="info-dialog"
        onClick={(e) => {
          if (e.target === e.currentTarget) setDialog(null);
        }}
      >
        <div className="dialog-inner">
          <div className="dialog-heading">
            <h2>
              {dialog === "settings"
                ? "시뮬레이션 설정"
                : "작은 오피스 사용 안내"}
            </h2>
            <button
              className="icon-button"
              aria-label="닫기"
              onClick={() => setDialog(null)}
            >
              <X size={20} />
            </button>
          </div>
          {dialog === "settings" ? (
            <>
              <p>
                시연은 브라우저 안에서만 실행되며 외부 서버에 정보를 보내지
                않습니다. 실제 AI 연결 설정은 아직 제공하지 않습니다.
              </p>
              <div className="setting-row">
                <div>
                  <strong>오피스 초기화</strong>
                  <p>진행 중인 시연과 모든 예시 이력을 지웁니다.</p>
                </div>
                <button
                  className="secondary-button"
                  onClick={() => {
                    clear();
                    setDialog(null);
                  }}
                >
                  <RotateCcw size={15} />
                  초기화
                </button>
              </div>
              <div className="setting-row">
                <div>
                  <strong>오류 상황 시연</strong>
                  <p>진행 중인 업무를 예시 오류 상태로 바꿉니다.</p>
                </div>
                <button
                  className="secondary-button"
                  disabled={!running}
                  onClick={() => {
                    fail();
                    setDialog(null);
                  }}
                >
                  오류 시연
                </button>
              </div>
              <p className="muted small">
                운영체제의 ‘동작 줄이기’ 설정을 켜면 캐릭터의 걷기·대기
                애니메이션을 줄입니다.
              </p>
            </>
          ) : (
            <>
              <p>
                교육 운영 업무의 흐름을 픽셀아트 사무실에서 살펴보는 개발
                미리보기입니다.
              </p>
              <ol className="help-steps">
                <li>
                  <Play size={17} />
                  <div>
                    <strong>업무를 선택해 주세요</strong>
                    <p>
                      6가지 업무 중 하나를 선택하면 약 15초간 예시 이벤트를
                      재생합니다.
                    </p>
                  </div>
                </li>
                <li>
                  <Users size={17} />
                  <div>
                    <strong>직원의 움직임을 살펴보세요</strong>
                    <p>
                      작업 구역 이동 → 업무 분석 → 작업 시연 → 공용 공간 검토
                      순으로 진행합니다. 직원 또는 지도 아래 직원 버튼을 눌러
                      정보를 확인하세요.
                    </p>
                  </div>
                </li>
                <li>
                  <FileText size={17} />
                  <div>
                    <strong>시연과 서버 집계를 구분해요</strong>
                    <p>
                      시연은 실제 업무를 실행하지 않습니다. 서버와 함께 실행하는
                      앱에서는 로그인 후 ‘서버 집계 보기’로 정량 집계·검토
                      기록을 확인할 수 있습니다. AI 호출과 외부 발송은
                      미연결입니다.
                    </p>
                  </div>
                </li>
              </ol>
              <div className="future-box">
                <strong>앞으로 연결할 기능</strong>
                <p>
                  Phase 3 업무 관리 확장 → Phase 4 실제 파일 자동화 → Phase 5
                  Codex 연동 → Phase 6 클라우드 배포·접근 통제
                </p>
              </div>
              <p className="muted small">
                상세 설계와 실행 방법은 저장소의 README 및 docs 폴더에 정리되어
                있습니다.
              </p>
            </>
          )}
          <button
            className="primary-button dialog-done"
            onClick={() => setDialog(null)}
          >
            <Check size={15} />
            확인했어요
          </button>
        </div>
      </dialog>
    </div>
  );
}
