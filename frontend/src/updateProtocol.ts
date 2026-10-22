export interface UpdateCursor {
  streamId: string;
  sequence: number;
}
export const cursorText = (cursor: UpdateCursor) =>
  `${cursor.streamId}:${cursor.sequence}`;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function parseCursor(value: unknown): UpdateCursor | null {
  if (typeof value !== "string") return null;
  const match = /^([a-f0-9]{32}):(0|[1-9][0-9]{0,15})$/.exec(value);
  return match && integer(Number(match[2]))
    ? { streamId: match[1]!, sequence: Number(match[2]) }
    : null;
}
const types = [
  "job.created",
  "job.imported",
  "attachment.added",
  "selection.saved",
  "run.changed",
  "review.decided",
];
const uuid = (value: unknown) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
export function acceptUpdate(current: UpdateCursor | null, value: unknown) {
  const fail = (): never => {
    throw new Error("변경 이력의 순서를 확인하지 못했습니다.");
  };
  if (!value || typeof value !== "object") return fail();
  const data = value as Record<string, unknown>;
  if (data.type === "ready") {
    const cursor = parseCursor(data.cursor);
    if (
      !cursor ||
      !integer(data.head) ||
      data.head < cursor.sequence ||
      typeof data.reset !== "boolean" ||
      (!data.reset && (!current || cursorText(current) !== data.cursor))
    )
      return fail();
    return {
      cursor,
      changed: true,
      replaying: cursor.sequence < data.head,
      reset: data.reset,
    };
  }
  if (!current) return fail();
  if (data.type === "heartbeat") {
    if (data.cursor !== cursorText(current)) return fail();
    return { cursor: current, changed: false, replaying: false, reset: false };
  }
  if (
    data.type !== "events" ||
    data.streamId !== current.streamId ||
    !integer(data.from) ||
    !integer(data.to) ||
    !integer(data.head) ||
    data.head < data.to ||
    !Array.isArray(data.events) ||
    data.events.length < 1 ||
    data.events.length > 100 ||
    data.to !== data.from + data.events.length ||
    data.from > current.sequence
  )
    return fail();
  for (const [i, entry] of data.events.entries()) {
    if (!entry || typeof entry !== "object") return fail();
    const e = entry as Record<string, unknown>;
    if (
      e.sequence !== data.from + i + 1 ||
      !types.includes(String(e.type)) ||
      !uuid(e.jobId) ||
      !(e.fileId === null || uuid(e.fileId)) ||
      !(e.runId === null || uuid(e.runId)) ||
      !(
        e.state === null ||
        (typeof e.state === "string" && e.state.length <= 32)
      ) ||
      !(e.revision === null || integer(e.revision)) ||
      typeof e.createdAt !== "string" ||
      e.createdAt.length > 32 ||
      !Number.isFinite(Date.parse(e.createdAt))
    )
      return fail();
  }
  const cursor = {
    streamId: current.streamId,
    sequence: Math.max(current.sequence, data.to),
  };
  return {
    cursor,
    changed: data.to > current.sequence,
    replaying: cursor.sequence < data.head,
    reset: false,
  };
}
