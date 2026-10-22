import type { StaffId, TaskKind } from "./simulation";

export interface JobActivity {
  active: { queued: number; running: number };
  latest: {
    runId: string;
    fileId: string;
    filename: string;
    revision: number;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    review: "pending" | "approved" | "rejected" | "summary_only" | null;
  }[];
}
export interface SavedJob {
  id: string;
  kind: TaskKind;
  title: string;
  instructions: string;
  assignedStaff: StaffId;
  status: "received";
  executionMode: "not_connected";
  createdAt: string;
  updatedAt: string;
  activity?: JobActivity;
}
export interface SavedEvent {
  id: string;
  jobId: string;
  type: "request_received";
  message: string;
  createdAt: string;
}
export interface JobDetail {
  job: SavedJob;
  events: SavedEvent[];
}
export interface JobPage {
  jobs: SavedJob[];
  page: { total: number; limit: number; offset: number; hasMore: boolean };
}
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Office-Request": "1",
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new Error(
      "업무 서버와 연결이 끊겼습니다. 입력 내용은 유지됩니다. 연결을 확인한 뒤 다시 시도해 주세요.",
    );
  }
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "업무 서버에 연결하지 못했습니다. API 서버 실행 상태를 확인해 주세요.",
    );
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("업무 서버의 응답을 읽지 못했습니다. 다시 시도해 주세요.");
  }
  if (!response.ok)
    throw new ApiError(
      data.error || "요청을 처리하지 못했습니다.",
      response.status,
    );
  return data as T;
}
export function jobsApi<T>(path: string, options: RequestInit = {}) {
  return apiRequest<T>(`/api/jobs${path}`, options);
}
