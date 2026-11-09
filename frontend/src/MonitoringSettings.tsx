import { METRICS, type MonitorMapping } from "./monitoring";
export default function MonitoringSettings({columns, value, disabled, onChange}: {
  columns: {index: number; letter: string; label: string}[]; value: MonitorMapping[]; disabled: boolean; onChange: (value: MonitorMapping[]) => void;
}) {
  return <fieldset disabled={disabled} className="survey-settings monitoring-settings" aria-label="모니터링 지표·열 연결">
    <legend>모니터링 지표·열 연결 · 선택</legend>
    <p className="session-note">선택한 열을 사람이 확인할 지표에 연결합니다. 최대 10개이며 단위는 표시용입니다. 계산·점수화·판정을 하지 않습니다. 열 제거나 시트·제목 행 변경 시 해당 연결도 제거됩니다.</p>
    <p className="session-note">열 선택·설문 설정과 같은 저장 버전을 사용합니다. 저장하면 진행 중 집계가 설정 변경으로 종료될 수 있으며, 기존 보관 결과는 바꾸지 않습니다.</p>
    {columns.map((column) => {
      const item = value.find((item) => item.index === column.index);
      const update = (change: Partial<MonitorMapping>) => onChange(value.map((entry) => entry.index === column.index ? {...entry, ...change} : entry));
      return <div key={column.index} className="survey-question">
        <label><input type="checkbox" checked={!!item} disabled={!item && value.length >= 10} onChange={(event) => onChange(event.target.checked
          ? [...value, {index: column.index, metric: "reference" as const, label: "", unit: ""}].sort((a, b) => a.index - b.index) : value.filter((item) => item.index !== column.index))} />{column.letter}열 지표 연결 · {column.label}</label>
        {item && <div className="survey-fields">
          <label>{column.letter}열 지표 종류<select value={item.metric} onChange={(event) => update({metric: event.target.value as MonitorMapping["metric"]})}>
            {Object.entries(METRICS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select></label>
          <label>{column.letter}열 지표 이름<input value={item.label} maxLength={60} placeholder="지표 이름을 직접 입력하세요." onChange={(event) => update({label: event.target.value})} /></label>
          <label>{column.letter}열 표시 단위 · 선택<input value={item.unit} maxLength={20} placeholder="예: 회, 시간, % (변환하지 않음)" onChange={(event) => update({unit: event.target.value})} /></label>
        </div>}
      </div>;
    })}
    {!columns.length && <p className="session-note">먼저 연결할 자료 열을 선택하세요.</p>}
  </fieldset>;
}
