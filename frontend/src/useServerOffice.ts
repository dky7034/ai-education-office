import { parseAiOffice, type AiOfficeView } from "./aiActivity";
import { parseServerOffice } from "./serverOffice";
import { useEffect, useMemo, useRef, useState } from "react";
import { jobsApi, ApiError } from "./jobsApi";
import type { ServerOffice, ServerOfficeView } from "./serverOffice";
export function useServerOffice(
  accountId: string,
  tick: number,
  connection: string,
  onUnauthorized: () => void,
  onChange?: (view: ServerOfficeView) => void,
) {
  const [data, setData] = useState<ServerOffice | null>(null),
    [error, setError] = useState(""),
    [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [ai, setAi] = useState<AiOfficeView & { accountId: string }>({ accountId, data: null, error: "", verifiedAt: null });
  const callbacks = useRef({ onUnauthorized, onChange });
  callbacks.current = { onUnauthorized, onChange };
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(10000),
    ]);
    void jobsApi<unknown>("/office", {
      signal,
      headers: { "X-Office-Account": accountId },
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        const snapshot = parseServerOffice(value);
        setData(snapshot);
        setError("");
        setVerifiedAt(new Date().toISOString());
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401)
          callbacks.current.onUnauthorized();
        setError(
          e instanceof Error
            ? e.message
            : "서버 집계 현황을 확인하지 못했습니다.",
        );
      });
    return () => controller.abort();
  }, [accountId, tick]);
  useEffect(() => {
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    void jobsApi<unknown>("/ai-office", { signal, headers: { "X-Office-Account": accountId } }).then((value) => {
      if (signal.aborted) return;
      const snapshot = parseAiOffice(value);
      setAi({ accountId, data: snapshot, error: "", verifiedAt: new Date().toISOString() });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) callbacks.current.onUnauthorized();
      setAi((previous) => ({ accountId, data: previous.accountId === accountId ? previous.data : null,
        verifiedAt: previous.accountId === accountId ? previous.verifiedAt : null,
        error: error instanceof Error ? error.message : "AI 서버 기록을 확인하지 못했습니다." }));
    });
    return () => controller.abort();
  }, [accountId, tick]);
  const view = useMemo(
    () => ({ accountId, data, error, verifiedAt, connection, ai: ai.accountId === accountId ? ai : { data: null, error: "", verifiedAt: null } }),
    [accountId, data, error, verifiedAt, connection, ai],
  );
  useEffect(() => {
    callbacks.current.onChange?.(view);
  }, [view]);
}
