import type { ServerOfficeView } from "./serverOffice";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { KeyRound, LogIn, LogOut, ShieldCheck } from "lucide-react";
import JobWorkspace from "./JobWorkspace";
import { apiRequest } from "./jobsApi";

interface User {
  id: string;
  username: string;
  createdAt: string;
}
interface Session {
  user: User | null;
  legacyCount: number;
}
type Mode = "login" | "register" | "recover";
const failure = (e: unknown) =>
  e instanceof Error ? e.message : "계정 요청을 처리하지 못했습니다.";
function clearSelected() {
  const url = new URL(location.href);
  url.searchParams.delete("job");
  history.replaceState(null, "", url);
}

export default function AccountWorkspace({
  onOfficeChange,
}: {
  onOfficeChange?: (view: ServerOfficeView | null) => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [jobsRevision, setJobsRevision] = useState(0);
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [recovery, setRecovery] = useState("");
  const [issuedCode, setIssuedCode] = useState("");
  const [renew, setRenew] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const currentId = useRef<string | null>(null);
  const generation = useRef(0);

  function apply(next: Session) {
    if (currentId.current !== (next.user?.id ?? null)) {
      onOfficeChange?.(null);
      if (currentId.current) clearSelected();
      setIssuedCode("");
      setRenew(false);
      setPassword("");
    }
    currentId.current = next.user?.id ?? null;
    setSession(next);
  }
  useEffect(() => {
    const abort = new AbortController(),
      token = ++generation.current;
    apiRequest<Session>("/api/auth/session", { signal: abort.signal })
      .then((next) => {
        if (!abort.signal.aborted && token === generation.current) {
          apply(next);
          setError("");
          setReady(true);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted && token === generation.current) {
          apply({ user: null, legacyCount: 0 });
          setError(failure(e));
          setReady(false);
        }
      });
    return () => abort.abort();
  }, [revision]);
  useEffect(() => {
    const refresh = () => {
      if (!busy.current && document.visibilityState === "visible")
        setRevision((v) => v + 1);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  function begin() {
    busy.current = true;
    setPending(true);
    setError("");
    setNotice("");
    generation.current++;
  }
  function finish() {
    busy.current = false;
    setPending(false);
    setPassword("");
    setRecovery("");
  }
  async function authenticate(event: FormEvent) {
    event.preventDefault();
    if (busy.current || !ready) return;
    begin();
    try {
      const result = await apiRequest<{ user?: User; recoveryCode?: string }>(
        `/api/auth/${mode}`,
        {
          method: "POST",
          body: JSON.stringify({
            username,
            password,
            ...(mode === "recover" ? { recoveryCode: recovery } : {}),
          }),
        },
      );
      if (mode === "recover") {
        apply({ user: null, legacyCount: session?.legacyCount ?? 0 });
        setMode("login");
        setNotice(
          "비밀번호를 변경하고 기존 로그인을 모두 종료했습니다. 새 복구 코드를 보관한 뒤 로그인해 주세요.",
        );
      } else if (result.user) {
        apply({ user: result.user, legacyCount: session?.legacyCount ?? 0 });
        setNotice(
          mode === "register"
            ? "계정을 만들었습니다. 복구 코드를 안전한 곳에 보관해 주세요."
            : "로그인했습니다. 계정의 업무 이력을 불러옵니다.",
        );
        setMode("login");
      }
      if (result.recoveryCode) setIssuedCode(result.recoveryCode);
      setRevision((v) => v + 1);
    } catch (e) {
      setError(failure(e));
    } finally {
      finish();
    }
  }
  async function logout() {
    if (busy.current) return;
    begin();
    try {
      await apiRequest("/api/auth/logout", { method: "POST", body: "{}" });
      apply({ user: null, legacyCount: session?.legacyCount ?? 0 });
      clearSelected();
      setIssuedCode("");
      setMode("login");
      setNotice("로그아웃했습니다. 저장한 업무는 계정에 그대로 보관됩니다.");
    } catch (e) {
      setError(failure(e));
    } finally {
      finish();
    }
  }
  async function importHistory() {
    if (busy.current || !session?.user) return;
    begin();
    try {
      const { imported } = await apiRequest<{ imported: number }>(
        "/api/auth/import-legacy",
        {
          method: "POST",
          headers: { "X-Office-Account": session.user.id },
          body: "{}",
        },
      );
      setSession((s) => (s ? { ...s, legacyCount: 0 } : s));
      setJobsRevision((v) => v + 1);
      setNotice(
        `기존 업무 ${imported}건을 이 계정으로 가져왔습니다. 원래 업무 ID와 이벤트는 보존됩니다.`,
      );
    } catch (e) {
      setError(failure(e));
    } finally {
      finish();
    }
  }
  async function renewCode(event: FormEvent) {
    event.preventDefault();
    if (busy.current || !session?.user) return;
    begin();
    try {
      const result = await apiRequest<{ recoveryCode: string }>(
        "/api/auth/renew-recovery",
        {
          method: "POST",
          headers: { "X-Office-Account": session.user.id },
          body: JSON.stringify({ password }),
        },
      );
      setIssuedCode(result.recoveryCode);
      setRenew(false);
      setNotice(
        "새 복구 코드를 발급했습니다. 이전 코드는 더 이상 사용할 수 없습니다.",
      );
    } catch (e) {
      setError(failure(e));
    } finally {
      finish();
    }
  }

  return (
    <>
      <section
        className="card account-card"
        id="account"
        aria-labelledby="account-title"
      >
        <div className="card-heading">
          <div>
            <h2 id="account-title">
              <ShieldCheck size={18} />
              계정·이력 복원
            </h2>
            <p>
              로그인한 계정에 업무를 보관하고, 다른 브라우저에서도 다시
              확인하세요.
            </p>
          </div>
          {session?.user && (
            <span className="account-name">{session.user.username}님</span>
          )}
        </div>
        <div className="account-body">
          {!ready && !error && (
            <p role="status">로그인 상태를 확인하고 있습니다.</p>
          )}
          {error && (
            <p role="alert" className="request-error">
              {error}
              {!ready && (
                <button
                  className="text-button"
                  onClick={() => setRevision((v) => v + 1)}
                >
                  다시 연결
                </button>
              )}
            </p>
          )}
          {notice && (
            <p role="status" className="request-success">
              {notice}
            </p>
          )}
          {issuedCode && (
            <div className="recovery-output">
              <h3>
                <KeyRound size={17} />
                복구 코드 보관
              </h3>
              <p>
                이 코드는 지금 한 번만 표시합니다. 계정 아이디와 함께 안전한
                곳에 따로 보관하고 다른 사람에게 공유하지 마세요. 재발급·사용
                후에는 이전 코드가 무효가 됩니다.
              </p>
              <code aria-label="계정 복구 코드">{issuedCode}</code>
              <button
                className="secondary-button"
                onClick={() => setIssuedCode("")}
              >
                복구 코드 보관 완료
              </button>
            </div>
          )}
          {ready && !session?.user && (
            <>
              <div className="account-tabs" aria-label="계정 메뉴">
                {(
                  [
                    ["login", "로그인"],
                    ["register", "회원가입"],
                    ["recover", "비밀번호 복구"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    disabled={pending}
                    aria-pressed={mode === value}
                    onClick={() => {
                      setMode(value);
                      setPassword("");
                      setRecovery("");
                      setError("");
                      setNotice("");
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <form
                className="account-form"
                aria-label={
                  mode === "register"
                    ? "회원가입"
                    : mode === "recover"
                      ? "비밀번호 복구"
                      : "로그인"
                }
                onSubmit={authenticate}
              >
                <fieldset disabled={pending || !ready}>
                  <label htmlFor="account-username">계정 아이디</label>
                  <input
                    id="account-username"
                    name="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    minLength={3}
                    maxLength={32}
                    autoComplete="username"
                    spellCheck={false}
                    autoCapitalize="none"
                    placeholder="영문으로 시작 · 영문·숫자·밑줄 3~32자"
                  />
                  {mode === "recover" && (
                    <>
                      <label htmlFor="account-recovery">복구 코드</label>
                      <input
                        id="account-recovery"
                        value={recovery}
                        onChange={(e) => setRecovery(e.target.value)}
                        type="password"
                        autoComplete="off"
                        maxLength={100}
                        required
                        spellCheck={false}
                      />
                    </>
                  )}
                  <label htmlFor="account-password">
                    {mode === "recover" ? "새 비밀번호" : "비밀번호"}
                  </label>
                  <input
                    id="account-password"
                    name="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={12}
                    maxLength={128}
                    autoComplete={
                      mode === "login" ? "current-password" : "new-password"
                    }
                    placeholder="12~128자"
                  />
                  <button className="primary-button" type="submit">
                    <LogIn size={15} />
                    {pending
                      ? "처리 중…"
                      : mode === "register"
                        ? "계정 만들기"
                        : mode === "recover"
                          ? "비밀번호 재설정"
                          : "로그인하기"}
                  </button>
                </fieldset>
              </form>
              <p className="session-note">
                이메일·휴대전화 인증은 아직 없습니다. 비밀번호와 복구 코드를
                모두 잃으면 계정을 복구할 수 없습니다. 실제 개인정보는 업무
                요청에 입력하지 마세요.
              </p>
            </>
          )}
          {ready && session?.user && (
            <>
              <div className="account-actions">
                <span>이 계정의 업무만 조회·저장합니다.</span>
                <button
                  className="secondary-button"
                  disabled={pending}
                  onClick={() => {
                    setRenew((v) => !v);
                    setPassword("");
                    setError("");
                  }}
                >
                  복구 코드 재발급
                </button>
                <button
                  className="secondary-button"
                  disabled={pending}
                  onClick={logout}
                >
                  <LogOut size={14} />
                  로그아웃
                </button>
              </div>
              {renew && (
                <form
                  className="account-form"
                  aria-label="복구 코드 재발급"
                  onSubmit={renewCode}
                >
                  <fieldset disabled={pending}>
                    <label htmlFor="renew-password">현재 비밀번호</label>
                    <input
                      id="renew-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={12}
                      maxLength={128}
                      autoComplete="current-password"
                    />
                    <button className="primary-button" type="submit">
                      새 복구 코드 발급
                    </button>
                  </fieldset>
                </form>
              )}
            </>
          )}
          {ready && !!session?.legacyCount && (
            <div className="legacy-import">
              <strong>
                이 브라우저의 기존 업무 {session.legacyCount}건을 찾았습니다.
              </strong>
              <p>
                공용 브라우저라면 본인의 업무인지 먼저 확인하세요. 가져오면 현재
                로그인한 계정에서 다른 브라우저로도 확인할 수 있습니다. 자동
                이전하지 않습니다.
              </p>
              {session.user ? (
                <button
                  className="secondary-button"
                  disabled={pending}
                  onClick={importHistory}
                >
                  기존 이력 가져오기
                </button>
              ) : (
                <p>로그인 후 기존 이력을 가져올 수 있습니다.</p>
              )}
            </div>
          )}
        </div>
      </section>
      {session?.user && ready && (
        <JobWorkspace
          key={session.user.id}
          accountId={session.user.id}
          onOfficeChange={(view) => {
            if (currentId.current === view.accountId) onOfficeChange?.(view);
          }}
          refreshKey={jobsRevision}
          onUnauthorized={() => {
            if (currentId.current === session.user!.id) {
              apply({ user: null, legacyCount: 0 });
              setRevision((v) => v + 1);
            }
          }}
        />
      )}
    </>
  );
}
