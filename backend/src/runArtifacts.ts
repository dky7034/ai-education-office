import {
  constants,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  readFileSync,
  fstatSync,
  lstatSync,
  renameSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { open, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { REPORT_CSP } from "./summaryReport.ts";
import { XLSX_MIME } from "./summaryXlsx.ts";
export type ArtifactFormat = "csv" | "html" | "xlsx";
export interface RunArtifact {
  format: ArtifactFormat;
  size: number;
  sha256: string;
  createdAt: string;
}
export const ARTIFACT_FORMATS: ArtifactFormat[] = ["csv", "html", "xlsx"];
export const ARTIFACT_LIMITS = {
  csv: 20 * 1024 * 1024,
  html: 5 * 1024 * 1024,
  xlsx: 20 * 1024 * 1024,
};
export const ARTIFACT_MIME = {
  csv: "text/csv; charset=utf-8",
  html: "text/html; charset=utf-8",
  xlsx: XLSX_MIME,
};
export { REPORT_CSP };
export const ARTIFACT_SCHEMA = `BEGIN IMMEDIATE;
CREATE TABLE summary_run_artifacts(run_id TEXT NOT NULL REFERENCES summary_runs(id),format TEXT NOT NULL CHECK(format IN ('csv','html','xlsx')),size INTEGER NOT NULL CHECK(size>0),sha256 TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(run_id,format));
PRAGMA user_version=7; COMMIT;`;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const idPattern = new RegExp("^" + uuid + "$");
const stagePattern = new RegExp("^\\.staging-(" + uuid + ")-(" + uuid + ")$");
export class ArtifactError extends Error {
  constructor() {
    super(
      "보관 파일이 없거나 무결성 검사에 실패했습니다. 원본 파일과 별도로 보관 상태를 확인해 주세요.",
    );
  }
}
export function outputPaths(root: string, runId: string, attempt: string) {
  if (!idPattern.test(runId) || !idPattern.test(attempt))
    throw new ArtifactError();
  return {
    stage: join(root, `.staging-${runId}-${attempt}`),
    final: join(root, runId),
  };
}
export function outputFile(
  root: string,
  runId: string,
  format: ArtifactFormat,
) {
  if (!idPattern.test(runId) || !ARTIFACT_FORMATS.includes(format))
    throw new ArtifactError();
  return join(root, runId, "summary." + format);
}
export function validArtifacts(value: RunArtifact[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    new Set(value.map((a) => a?.format)).size === 3 &&
    value.every(
      (a) =>
        a &&
        ARTIFACT_FORMATS.includes(a.format) &&
        Number.isSafeInteger(a.size) &&
        a.size > 0 &&
        a.size <= ARTIFACT_LIMITS[a.format] &&
        /^[a-f0-9]{64}$/.test(a.sha256) &&
        typeof a.createdAt === "string" &&
        !Number.isNaN(Date.parse(a.createdAt)),
    )
  );
}
function syncDirectory(path: string) {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function writeArtifactSet(
  stage: string,
  buffers: Record<ArtifactFormat, Buffer>,
  createdAt: string,
): RunArtifact[] {
  const artifacts = ARTIFACT_FORMATS.map((format) => ({
    format,
    size: buffers[format].length,
    sha256: createHash("sha256").update(buffers[format]).digest("hex"),
    createdAt,
  }));
  if (!validArtifacts(artifacts)) throw new ArtifactError();
  mkdirSync(dirname(stage), { recursive: true, mode: 0o700 });
  mkdirSync(stage, { mode: 0o700 });
  for (const format of ARTIFACT_FORMATS) {
    const fd = openSync(join(stage, "summary." + format), "wx", 0o600);
    try {
      writeFileSync(fd, buffers[format]);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  syncDirectory(stage);
  return artifacts;
}
export function publishArtifactSet(
  stage: string,
  final: string,
  artifacts: RunArtifact[],
) {
  if (!validArtifacts(artifacts) || lstatSync(stage).isSymbolicLink())
    throw new ArtifactError();
  for (const a of artifacts) {
    const fd = openSync(
      join(stage, "summary." + a.format),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== a.size) throw new ArtifactError();
      const data = readFileSync(fd);
      if (
        data.length !== a.size ||
        createHash("sha256").update(data).digest("hex") !== a.sha256
      )
        throw new ArtifactError();
    } finally {
      closeSync(fd);
    }
  }
  renameSync(stage, final);
  syncDirectory(dirname(final));
}
export function discardOutputs(
  stage: string,
  final: string,
  keepFinal: boolean,
) {
  try {
    rmSync(stage, { recursive: true, force: true });
  } catch {
    console.error("집계 임시 파일을 정리하지 못했습니다.");
  }
  if (!keepFinal)
    try {
      rmSync(final, { recursive: true, force: true });
    } catch {
      console.error("미완료 집계 파일을 정리하지 못했습니다.");
    }
}
export function sweepOutputs(
  root: string,
  status: (id: string) => string | null,
  activeStage?: string,
) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const match = stagePattern.exec(entry.name),
      id = match?.[1] ?? (idPattern.test(entry.name) ? entry.name : null);
    if (!id) continue;
    const state = status(id),
      path = join(root, entry.name);
    if (!state || path === activeStage) continue;
    if (match || state !== "completed")
      rmSync(path, { recursive: true, force: true });
  }
}
export async function readArtifact(path: string, artifact: RunArtifact) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 1 ||
      artifact.size > ARTIFACT_LIMITS[artifact.format] ||
      (await lstat(dirname(path))).isSymbolicLink()
    )
      throw new ArtifactError();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== artifact.size)
      throw new ArtifactError();
    const buffer = Buffer.allocUnsafe(artifact.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const data = buffer.subarray(0, length);
    if (
      data.length !== artifact.size ||
      createHash("sha256").update(data).digest("hex") !== artifact.sha256
    )
      throw new ArtifactError();
    return data;
  } catch {
    throw new ArtifactError();
  } finally {
    await file?.close();
  }
}
