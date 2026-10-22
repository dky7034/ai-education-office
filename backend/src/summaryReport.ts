import type { summarize } from "./summary.ts";
import { SURVEY_RULE } from "./survey.ts";
import { NUMERIC_RULE } from "./numericSummary.ts";
import { PreviewError } from "./tabular.ts";
interface ReportMeta {
  jobId: string;
  fileId: string;
  filename: string;
  sourceHash: string;
  revision: number;
  calculatedAt: string;
  runId?: string;
}
export const REPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const escape = (value: string | number) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function summaryReport(
  summary: ReturnType<typeof summarize>,
  meta: ReportMeta,
  byteLimit = 5 * 1024 * 1024,
) {
  const counts = (items: [string, number][]) =>
    `<dl>${items.map(([label, count]) => `<div><dt>${escape(label)}</dt><dd>${count.toLocaleString("ko-KR")}</dd></div>`).join("")}</dl>`;
  const survey = summary.survey
    ? `<section><h2>설문 기준 집계 결과</h2><p class="note">${escape(SURVEY_RULE)}</p>${counts(
        [
          ["유효 응답 행", summary.survey.validRows],
          ["기준 미충족 행", summary.survey.invalidRows],
        ],
      )}${summary.survey.questions
        .map(
          (q) =>
            `<h3>${escape(q.letter)} · ${escape(q.label)} · ${q.min}~${q.max} 정수 · ${q.required ? "필수" : "선택"}</h3>${counts(
              [
                ["유효값", q.validCount],
                ["누락", q.missingCount],
                ["수식 제외", q.formulaCount],
                ["오류 제외", q.errorCount],
                ["숫자 아님", q.nonNumericCount],
                ["정수 아님", q.nonIntegerCount],
                ["범위 밖", q.outOfRangeCount],
              ],
            )}<dl>${(
              [
                ["유효값 합계", q.sum],
                ["유효값 평균", q.mean],
                ["유효값 최솟값", q.minValue],
                ["유효값 최댓값", q.maxValue],
              ] as const
            )
              .map(
                ([name, value]) =>
                  `<div><dt>${name}</dt><dd class="decimal">${escape(value ?? "—")}</dd></div>`,
              )
              .join("")}</dl>`,
        )
        .join("")}</section>`
    : "";
  const columns = summary.columns
    .map(
      (c) =>
        `<section><h2>${escape(c.letter)} · ${escape(c.label)}</h2>${counts([
          ["일반 값", c.valueCount],
          ["누락", c.missingCount],
          ["수식 제외", c.formulaCount],
          ["오류 제외", c.errorCount],
          ["서로 다른 일반 값", c.distinctCount],
        ])}<div class="numeric-summary"><h3>숫자 기초 집계</h3><p class="note">${escape(NUMERIC_RULE)}</p>${counts(
          [
            ["숫자 인정", c.numeric.count],
            ["숫자 아닌 일반 값", c.numeric.nonNumericCount],
            ["숫자 범위 초과", c.numeric.outOfRangeCount],
          ],
        )}<dl>${(
          [
            ["합계", c.numeric.sum],
            ["평균", c.numeric.mean],
            ["최솟값", c.numeric.min],
            ["최댓값", c.numeric.max],
          ] as const
        )
          .map(
            ([name, value]) =>
              `<div><dt>${name}</dt><dd class="decimal">${escape(value ?? "—")}</dd></div>`,
          )
          .join(
            "",
          )}</dl>${c.numeric.count === 0 ? "<p>숫자로 인정한 값이 없습니다.</p>" : ""}</div><p>일반 값 ${c.valueCount}개 중 상위 최대 10개 · 누락·수식·오류 제외</p><ol class="chart">${c.frequencies
          .slice(0, 10)
          .map(
            (e) =>
              `<li><div class="label"><span>${escape(e.value)}${e.valueTruncated ? "… (표시 줄임)" : ""}</span><strong>${e.count}건 · ${(c.valueCount ? (e.count / c.valueCount) * 100 : 0).toFixed(1)}%</strong></div><div class="track" aria-hidden="true"><div style="width:${c.valueCount ? (e.count / c.valueCount) * 100 : 0}%"></div></div></li>`,
          )
          .join(
            "",
          )}</ol>${c.frequencies.length ? `<table><caption>일반 값 빈도 · 상위 최대 30개</caption><thead><tr><th scope="col">값</th><th scope="col">건수</th></tr></thead><tbody>${c.frequencies.map((e) => `<tr><td>${escape(e.value)}${e.valueTruncated ? "… (표시 줄임)" : ""}</td><td>${e.count}</td></tr>`).join("")}</tbody></table>` : "<p>빈도를 표시할 일반 값이 없습니다.</p>"}${c.otherDistinctCount ? `<p>나머지 ${c.otherDistinctCount}종: 총 ${c.otherCount}건</p>` : ""}</section>`,
    )
    .join("");
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(REPORT_CSP)}"><title>선택 열 기초 집계 보고서</title><style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;color:#183a32;background:#f3f7f5;margin:0;padding:24px;line-height:1.6}main{max-width:900px;margin:auto;background:white;padding:32px;border-radius:16px}h1{font-size:26px}h2{font-size:20px}section{border-top:1px solid #cbded5;margin-top:28px;padding-top:16px}dl{display:flex;flex-wrap:wrap;gap:12px}dl>div{background:#edf5f0;padding:12px;flex:1;min-width:120px}dt{font-size:13px}dd{margin:0;font-size:24px;font-weight:bold}.decimal{overflow-wrap:anywhere;font-size:18px}.numeric-summary{border:1px solid #dbe5df;padding:12px;margin:16px 0}.meta{overflow-wrap:anywhere;font-size:13px}.chart{list-style:none;padding:0}.chart li{margin:14px 0;break-inside:avoid}.label{display:flex;justify-content:space-between;gap:16px;overflow-wrap:anywhere}.label span{min-width:0;white-space:pre-wrap}.label strong{flex-shrink:0}.track{height:12px;background:#edf1ef;border-radius:6px;overflow:hidden}.track>div{height:100%;background:#368568}table{width:100%;border-collapse:collapse;table-layout:fixed}caption{text-align:left;font-weight:bold}th,td{padding:8px;border-bottom:1px solid #dbe5df;text-align:left;overflow-wrap:anywhere;white-space:pre-wrap}th:last-child,td:last-child{width:80px;text-align:right}.note{color:#486458;font-size:14px}@media(max-width:600px){body{padding:8px}main{padding:16px}.label{flex-wrap:wrap;gap:0}}@media print{body{background:white;padding:0}main{padding:0;max-width:none}h2,caption{break-after:avoid}tr{break-inside:avoid}thead{display:table-header-group}.track,.track>div{print-color-adjust:exact}}
</style></head><body><main><h1>선택 열 기초 집계 보고서</h1><p class="note">저장 원본의 정량 집계입니다. AI 해석·교육생 평가·자동 발송은 수행하지 않습니다. 브라우저에서 열어 인쇄하거나 PDF로 저장할 수 있습니다.</p><div class="meta"><p>원본 파일: ${escape(meta.filename)}<br>시트: ${escape(summary.sheetName)} · 제목 ${summary.headerRow}행 · 선택 버전 ${meta.revision}<br>생성 시각(UTC): ${escape(meta.calculatedAt)}<br>업무 ID: ${escape(meta.jobId)}${meta.runId ? `<br>집계 작업 ID: ${escape(meta.runId)}` : ""}<br>원본 파일 ID: ${escape(meta.fileId)}<br>원본 SHA-256: ${escape(meta.sourceHash)}</p></div>${counts(
    [
      ["제목 이후 전체 행", summary.totalRows],
      ["집계 포함 행", summary.includedRows],
      ["선택 열 공란 제외 행", summary.excludedRows],
    ],
  )}<section><h2>집계 기준</h2><ul><li>선택한 시트·제목 행·열의 전체 데이터를 계산합니다. 선택 열이 모두 공란인 행은 제외합니다. 행 수는 응답자 수가 아닙니다.</li><li>앞뒤 공백만 제거하며 대소문자·숫자 표기·내부 공백을 유지합니다. XLSX 수식·오류는 별도로 세며 실행하지 않습니다. CSV 수식 모양은 문자열입니다.</li><li>숫자·날짜는 원본 저장값, 불리언은 표시 문자열입니다. 숨김 시트·행·열도 포함될 수 있습니다.</li><li>막대의 분모는 일반 값 전체입니다. 상위 10개 그래프·30개 빈도를 표시하며 긴 값은 200자로 줄입니다. 전체 빈도와 원문은 앱의 CSV 다운로드에서 확인하세요.</li><li>원본·저장 선택·업무 상태는 변경하지 않습니다. 생성 시점의 결과이며 이후 변경을 반영하지 않습니다.</li></ul></section>${survey}${columns}</main></body></html>`;
  const result = Buffer.from(html);
  if (result.length > byteLimit)
    throw new PreviewError(
      "HTML 보고서가 5MiB를 초과했습니다. 선택 열을 줄여 다시 시도해 주세요.",
    );
  return result;
}
