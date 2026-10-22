import { parentPort, workerData } from "node:worker_threads";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readXlsx, MAX_FILE_BYTES } from "./attachments.ts";
import { summarize } from "./summary.ts";
import { PreviewError } from "./tabular.ts";
import type { ColumnSelection } from "./store.ts";
interface Input {
  path: string;
  size: number;
  hash: string;
  format: "csv" | "xlsx";
  selection: ColumnSelection;
}
const input = workerData as Input;
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
  const summary = summarize(input.format, bytes, xml, input.selection);
  parentPort!.postMessage({
    ok: true,
    summary: {
      ...summary,
      revision: input.selection.revision,
      sourceHash: input.hash,
      calculatedAt: new Date().toISOString(),
    },
  });
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error:
      error instanceof PreviewError
        ? error.message
        : "원본을 확인하거나 집계를 실행하지 못했습니다. 원본 크기·해시와 파일 상태를 확인해 주세요.",
  });
} finally {
  parentPort!.close();
}
