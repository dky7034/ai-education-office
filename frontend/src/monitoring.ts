export const METRICS = {attendance: "출석 자료", progress: "진도 자료", submission: "과제 자료", reference: "참고 자료"} as const;
export interface MonitorMapping {index: number; metric: keyof typeof METRICS; label: string; unit: string}
