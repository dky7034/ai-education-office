import { createContext, useEffect, useRef, useState } from "react";

export const JobUpdateRevision = createContext("");
export function useJobUpdates(accountId: string) {
  const [tick, setTick] = useState(0),
    [revision, setRevision] = useState(""),
    [status, setStatus] = useState("자동 갱신 연결 중");
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    let stopped = false,
      socket: WebSocket | null = null,
      timer: ReturnType<typeof setTimeout> | undefined,
      watchdog: ReturnType<typeof setTimeout> | undefined,
      attempts = 0,
      epoch = 0;
    const clear = () => {
      clearTimeout(timer);
      clearTimeout(watchdog);
      if (socket) {
        const old = socket;
        socket = null;
        old.onclose = old.onmessage = old.onerror = old.onopen = null;
        old.close();
      }
    };
    function connect() {
      clear();
      if (stopped) return;
      if (!navigator.onLine) {
        setStatus("오프라인 · 표시된 기록 유지");
        return;
      }
      setStatus(
        attempts
          ? "자동 갱신 재연결 중 · 표시된 기록 유지"
          : "자동 갱신 연결 중",
      );
      const url = new URL("/api/jobs/updates", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("account", accountId);
      const current = new WebSocket(url);
      socket = current;
      const connection = ++epoch;
      const watch = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => current.close(), 35000);
      };
      watch();
      current.onmessage = (event) => {
        if (stopped || socket !== current) return;
        try {
          const data = JSON.parse(String(event.data));
          if (data.type !== "snapshot" || !/^[a-f0-9]{64}$/.test(data.revision))
            return;
          attempts = 0;
          watch();
          setStatus("자동 갱신 연결됨");
          setRevision(`${connection}:${data.revision}`);
          setTick((v) => v + 1);
        } catch {
          current.close();
        }
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (stopped || socket !== current) return;
        clearTimeout(watchdog);
        setStatus("자동 갱신 재연결 중 · 표시된 기록 유지");
        // A failed upgrade can mean an expired session. Read-only refresh checks
        // HTTP authentication too; never retry a POST on reconnection.
        setTick((v) => v + 1);
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5));
        timer = setTimeout(connect, delay + Math.random() * 250);
      };
    }
    const wake = () => {
      if (document.visibilityState !== "hidden") {
        setTick((v) => v + 1);
        if (!socket || socket.readyState !== WebSocket.OPEN) connect();
      }
    };
    const offline = () => {
      clear();
      setStatus("오프라인 · 표시된 기록 유지");
    };
    retry.current = () => {
      attempts = 0;
      connect();
      setTick((v) => v + 1);
    };
    window.addEventListener("online", wake);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    connect();
    return () => {
      stopped = true;
      clear();
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [accountId]);
  return { tick, revision, status, reconnect: () => retry.current() };
}
