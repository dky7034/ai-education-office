import { PreviewError } from "./tabular.ts";
export type Metric = "attendance" | "progress" | "submission" | "reference";
export interface MonitorMapping { index: number; metric: Metric; label: string; unit: string }
export function monitorMappings(value: unknown, columns: readonly number[]): MonitorMapping[] {
  if (!Array.isArray(value) || value.length > 10) throw new PreviewError("지표 연결은 최대 10개까지 저장할 수 있습니다.");
  const seen = new Set<number>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some((key) => !["index", "metric", "label", "unit"].includes(key))
      || !Number.isInteger(item.index) || item.index < 0 || item.index >= 100 || !columns.includes(item.index) || seen.has(item.index)
      || !["attendance", "progress", "submission", "reference"].includes(item.metric)
      || typeof item.label !== "string" || !item.label.trim() || item.label.trim().length > 60
      || typeof item.unit !== "string" || item.unit.trim().length > 20
      || /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(item.label + item.unit))
      throw new PreviewError("선택한 열마다 하나의 지표 종류·이름(1~60자)·단위(최대 20자)를 입력해 주세요. 줄바꿈·제어 문자는 사용할 수 없습니다.");
    seen.add(item.index);
    return {index: item.index as number, metric: item.metric as Metric, label: item.label.trim(), unit: item.unit.trim()};
  }).sort((a, b) => a.index - b.index);
}
export const MONITORING_SCHEMA = `BEGIN IMMEDIATE; ALTER TABLE column_selections ADD COLUMN monitoring_json TEXT NOT NULL DEFAULT '[]'; PRAGMA user_version=13; COMMIT;`;
