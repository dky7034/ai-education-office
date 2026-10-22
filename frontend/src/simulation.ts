export type StaffId =
  | "lead"
  | "analyst"
  | "learner"
  | "writer"
  | "designer"
  | "coordinator";
export type Status =
  | "대기 중"
  | "이동 중"
  | "업무 분석 중"
  | "문서 작성 중"
  | "작업 실행 중"
  | "검토 중"
  | "승인 대기"
  | "작업 완료"
  | "오류 발생";
export type TaskKind =
  | "survey"
  | "notice"
  | "monitor"
  | "excel"
  | "slides"
  | "schedule";
export type Phase =
  | "assigned"
  | "moving"
  | "analyzing"
  | "working"
  | "reviewing"
  | "awaiting"
  | "completed"
  | "failed";
export type Point = { x: number; y: number };
export interface Staff {
  displayStatus?: string;
  id: StaffId;
  name: string;
  short: string;
  role: string;
  color: string;
  room: string;
  desk: Point;
  home: Point;
  status: Status;
  target: Point;
  task: string | null;
  history: string[];
}
export interface TaskDefinition {
  id: TaskKind;
  title: string;
  description: string;
  staff: StaffId;
  action: Status;
  sample: string;
}
export const TASKS: TaskDefinition[] = [
  {
    id: "survey",
    title: "강의 설문 분석",
    description: "설문 집계와 피드백 요약",
    staff: "analyst",
    action: "작업 실행 중",
    sample: "가상 설문 데이터의 집계 과정을 시연합니다.",
  },
  {
    id: "notice",
    title: "공지·메일 작성",
    description: "대상에 맞는 안내문 초안",
    staff: "writer",
    action: "문서 작성 중",
    sample: "가상 교육 안내문 작성 과정을 시연합니다.",
  },
  {
    id: "monitor",
    title: "교육생 모니터링",
    description: "활동 근거와 참여 기록 정리",
    staff: "learner",
    action: "작업 실행 중",
    sample: "활동 근거 확인 과정을 시연하며 평가 점수는 생성하지 않습니다.",
  },
  {
    id: "excel",
    title: "엑셀 관리",
    description: "시트·수식·데이터 검증",
    staff: "analyst",
    action: "작업 실행 중",
    sample: "가상 워크북의 데이터 검증 과정을 시연합니다.",
  },
  {
    id: "slides",
    title: "PPT 제작",
    description: "교육 자료와 슬라이드 구성",
    staff: "designer",
    action: "문서 작성 중",
    sample: "가상 발표자료 구성 과정을 시연합니다.",
  },
  {
    id: "schedule",
    title: "교육 일정 관리",
    description: "일정 확인과 리마인드 초안",
    staff: "coordinator",
    action: "작업 실행 중",
    sample: "가상 일정 충돌 확인 과정을 시연합니다.",
  },
];

const definitions = [
  {
    id: "lead",
    name: "운영팀장",
    short: "운영",
    role: "요청 분류 · 업무 배정 · 결과 검토",
    color: "#c88c53",
    room: "운영관리실",
  },
  {
    id: "analyst",
    name: "데이터 분석가",
    short: "분석",
    role: "설문 분석 · 엑셀 집계 · 데이터 검증",
    color: "#5b93bc",
    room: "데이터 분석실",
  },
  {
    id: "learner",
    name: "교육생 관리 담당",
    short: "교육",
    role: "활동 근거 정리 · 모니터링",
    color: "#779d69",
    room: "교육생 관리실",
  },
  {
    id: "writer",
    name: "문서 전문가",
    short: "문서",
    role: "강의 요약 · 보고서 · 안내문 초안",
    color: "#a38cbd",
    room: "문서 작업실",
  },
  {
    id: "designer",
    name: "콘텐츠 디자이너",
    short: "제작",
    role: "PPT 구성 · 교육 안내자료 디자인",
    color: "#ce8390",
    room: "콘텐츠 제작실",
  },
  {
    id: "coordinator",
    name: "일정·소통 담당",
    short: "소통",
    role: "일정 관리 · 메일 및 리마인드 초안",
    color: "#57a89d",
    room: "커뮤니케이션실",
  },
] as const;

export function createStaff(): Staff[] {
  return definitions.map((d, i) => {
    const x = 168 + (i % 3) * 300;
    const home = { x: x + 64, y: i < 3 ? 232 : 528 };
    return {
      ...d,
      home,
      desk: { x, y: i < 3 ? 207 : 497 },
      status: "대기 중",
      target: home,
      task: null,
      history: [],
    };
  });
}
export interface Job {
  id: string;
  kind: TaskKind;
  phase: Phase;
  startedAt: string;
}
export interface Log {
  id: number;
  time: string;
  text: string;
  level: "info" | "success" | "error";
}
export interface OfficeState {
  staff: Staff[];
  job: Job | null;
  logs: Log[];
  sequence: number;
}
export const PHASE_LABELS: Record<Phase, string> = {
  assigned: "업무 배정",
  moving: "작업 구역 이동",
  analyzing: "업무 분석",
  working: "작업 시연",
  reviewing: "공용 공간 검토",
  awaiting: "승인 대기 시연",
  completed: "시연 완료",
  failed: "오류 시연",
};
export const TIMELINE: { after: number; phase: Phase }[] = [
  { after: 500, phase: "moving" },
  { after: 3500, phase: "analyzing" },
  { after: 5500, phase: "working" },
  { after: 8000, phase: "reviewing" },
  { after: 11500, phase: "awaiting" },
  { after: 14000, phase: "completed" },
];
export function initialState(): OfficeState {
  return {
    staff: createStaff(),
    job: null,
    sequence: 1,
    logs: [
      {
        id: 0,
        time: "—",
        text: "시뮬레이션 오피스가 열렸습니다. 업무를 선택하면 직원의 이동과 상태 변화를 볼 수 있습니다.",
        level: "info",
      },
    ],
  };
}
export function isRunning(state: OfficeState): boolean {
  return !!state.job && !["completed", "failed"].includes(state.job.phase);
}
export type OfficeAction =
  | { type: "start"; kind: TaskKind; id: string; time: string }
  | { type: "advance"; jobId: string; phase: Phase; time: string }
  | { type: "reset" };

export function officeReducer(
  state: OfficeState,
  action: OfficeAction,
): OfficeState {
  if (action.type === "reset") return initialState();
  if (action.type === "start") {
    if (isRunning(state)) return state;
    const definition = TASKS.find((t) => t.id === action.kind)!;
    const staff = state.staff.map((p) => ({
      ...p,
      status: (p.id === "lead" ? "업무 분석 중" : "대기 중") as Status,
      task:
        p.id === "lead" || p.id === definition.staff ? definition.title : null,
      target: p.home,
    }));
    return {
      ...state,
      staff,
      job: {
        id: action.id,
        kind: action.kind,
        phase: "assigned",
        startedAt: action.time,
      },
      sequence: state.sequence + 1,
      logs: [
        ...state.logs,
        {
          id: state.sequence,
          time: action.time,
          text: `[시뮬레이션] ${definition.title} · 운영팀장이 ${staff.find((p) => p.id === definition.staff)!.name}에게 배정했습니다.`,
          level: "info" as const,
        },
      ].slice(-60),
    };
  }
  const job = state.job;
  // Ignore stale timers, out-of-order steps and updates to finished jobs.
  if (!job || job.id !== action.jobId || !isRunning(state)) return state;
  const order: Phase[] = [
    "assigned",
    "moving",
    "analyzing",
    "working",
    "reviewing",
    "awaiting",
    "completed",
  ];
  if (
    action.phase !== "failed" &&
    order.indexOf(action.phase) !== order.indexOf(job.phase) + 1
  )
    return state;
  const definition = TASKS.find((t) => t.id === job.kind)!;
  const phase = action.phase;
  const status: Status =
    phase === "moving"
      ? "이동 중"
      : phase === "analyzing"
        ? "업무 분석 중"
        : phase === "working"
          ? definition.action
          : phase === "reviewing"
            ? "검토 중"
            : phase === "awaiting"
              ? "승인 대기"
              : phase === "failed"
                ? "오류 발생"
                : "작업 완료";
  const staff = state.staff.map((p) => {
    if (p.id === definition.staff)
      return {
        ...p,
        status,
        target: ["reviewing", "awaiting", "completed"].includes(phase)
          ? { x: 746, y: 606 }
          : phase === "failed"
            ? p.target
            : p.desk,
        history: ["completed", "failed"].includes(phase)
          ? [
              `${definition.title} · ${PHASE_LABELS[phase]}`,
              ...p.history,
            ].slice(0, 5)
          : p.history,
      };
    if (p.id === "lead")
      return {
        ...p,
        status: (phase === "reviewing" ? "검토 중" : "대기 중") as Status,
        target: ["reviewing", "awaiting", "completed"].includes(phase)
          ? { x: 654, y: 606 }
          : p.home,
      };
    return p;
  });
  const messages: Record<Exclude<Phase, "assigned">, string> = {
    moving: "담당 직원이 작업 구역으로 이동합니다.",
    analyzing: "요청 내용을 살펴보는 단계입니다. 실제 데이터는 읽지 않습니다.",
    working: definition.sample,
    reviewing: "담당 직원과 운영팀장이 공용 검수 공간으로 이동합니다.",
    awaiting:
      "승인 대기 상태의 표시 예시입니다. 실제 승인 요청은 생성되지 않습니다.",
    completed:
      "시연을 마쳤습니다. 실제 결과물 생성·사용자 승인·외부 발송은 수행하지 않았습니다.",
    failed:
      "오류 상황을 시연했습니다. 실제 서비스 장애가 아니며 업무를 다시 선택해 재생할 수 있습니다.",
  };
  return {
    ...state,
    staff,
    job: { ...job, phase },
    sequence: state.sequence + 1,
    logs: [
      ...state.logs,
      {
        id: state.sequence,
        time: action.time,
        text: `[시뮬레이션] ${messages[phase as Exclude<Phase, "assigned">]}`,
        level:
          phase === "failed"
            ? ("error" as const)
            : phase === "completed"
              ? ("success" as const)
              : ("info" as const),
      },
    ].slice(-60),
  };
}
