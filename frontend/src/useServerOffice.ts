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
  const view = useMemo(
    () => ({ accountId, data, error, verifiedAt, connection }),
    [accountId, data, error, verifiedAt, connection],
  );
  useEffect(() => {
    callbacks.current.onChange?.(view);
  }, [view]);
}
