import { useEffect, useReducer, useRef } from "react";
import {
  initialState,
  isRunning,
  officeReducer,
  TIMELINE,
  type TaskKind,
} from "./simulation";

const time = () => new Date().toLocaleTimeString("ko-KR", { hour12: false });
export function useOffice() {
  const [state, dispatch] = useReducer(officeReducer, undefined, initialState);
  // Session-local simulation identifiers, never credentials or persistent job IDs.
  // Embedded previews may not provide the secure-context-only randomUUID API.
  const sequence = useRef(0);
  const jobId = state.job?.id;
  const running = isRunning(state);
  useEffect(() => {
    if (!jobId || !running) return;
    const timers = TIMELINE.map((step) =>
      window.setTimeout(
        () =>
          dispatch({ type: "advance", jobId, phase: step.phase, time: time() }),
        step.after,
      ),
    );
    return () => timers.forEach(window.clearTimeout);
  }, [jobId, running]);
  return {
    state,
    running,
    start: (kind: TaskKind) =>
      dispatch({
        type: "start",
        kind,
        id: `demo-${Date.now().toString(36)}-${++sequence.current}`,
        time: time(),
      }),
    reset: () => dispatch({ type: "reset" }),
    fail: () =>
      jobId &&
      dispatch({ type: "advance", jobId, phase: "failed", time: time() }),
  };
}
