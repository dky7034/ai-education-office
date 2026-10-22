import { parentPort, workerData } from "node:worker_threads";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readXlsx, MAX_FILE_BYTES } from "./attachments.ts";
import { summaryCsv } from "./summaryCsv.ts";
import { summaryReport } from "./summaryReport.ts";
import { summaryXlsx } from "./summaryXlsx.ts";
import { writeArtifactSet } from "./runArtifacts.ts";
import { displaySummary } from "./summary.ts";
import { summarize } from "./summary.ts";
import { PreviewError } from "./tabular.ts";
import type { ColumnSelection } from "./store.ts";
interface Input {
  path: string;
  size: number;
  hash: string;
  format: "csv" | "xlsx";
  selection: ColumnSelection;
  stage: string;
  runId: string;
  jobId: string;
  fileId: string;
  filename: string;
}
const input = workerData as Input;
let outputPhase = false;
try {
  if (
    input.size > MAX_FILE_BYTES ||
    (await stat(input.path)).size !== input.size
  )
    throw new Error("original");
  const bytes = await readFile(input.path);
  if (
    bytes.length !== input.size ||
    createHash("sha256").update(bytes).digest("hex") !== input.hash
  )
    throw new Error("original");
  let xml: Map<string, string> | null = null;
  if (input.format === "xlsx") {
    try {
      xml = await readXlsx(bytes);
    } catch {
      throw new PreviewError("XLSX 구조를 읽지 못했습니다.");
    }
  }
  const full = summarize(input.format, bytes, xml, input.selection, {
    fullValues: true,
    frequencyLimit: Infinity,
  });
  const summary = displaySummary(full),
    calculatedAt = new Date().toISOString();
  const result = {
    ...summary,
    revision: input.selection.revision,
    sourceHash: input.hash,
    calculatedAt,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 5 * 1024 * 1024)
    throw new PreviewError("집계 결과가 저장 한도 5MiB를 초과했습니다.");
  outputPhase = true;
  const meta = {
    jobId: input.jobId,
    fileId: input.fileId,
    filename: input.filename,
    sourceHash: input.hash,
    revision: input.selection.revision,
    calculatedAt,
    runId: input.runId,
  };
  const buffers = {
    csv: summaryCsv(full, meta),
    html: summaryReport(summary, meta),
    xlsx: await summaryXlsx(full, meta),
  };
  const artifacts = writeArtifactSet(input.stage, buffers, calculatedAt);
  parentPort!.postMessage({ ok: true, summary: result, artifacts });
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error:
      error instanceof PreviewError
        ? error.message
        : outputPhase
          ? "집계 결과 파일을 생성·보관하지 못했습니다. 저장 공간과 경로를 확인해 주세요."
          : "원본을 확인하거나 집계를 실행하지 못했습니다. 원본 크기·해시와 파일 상태를 확인해 주세요.",
  });
} finally {
  parentPort!.close();
}
