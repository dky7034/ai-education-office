import express, { type RequestHandler } from "express";
import {
  ARTIFACT_FORMATS,
  ARTIFACT_MIME,
  ArtifactError,
  REPORT_CSP,
  outputFile,
  readArtifact,
  type ArtifactFormat,
} from "./runArtifacts.ts";
import type { Store } from "./store.ts";
import { RunError } from "./runStore.ts";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function runRoutes(store: Store, requireAccount: RequestHandler) {
  const router = express.Router(),
    base = "/:id/attachments/:fileId/runs";
  router.use(base, (req, res, next) => {
    if (
      !uuid.test(String(req.params.id)) ||
      !uuid.test(String(req.params.fileId)) ||
      !store
        .attachments(res.locals.account.id, String(req.params.id))
        ?.some((f) => f.id === req.params.fileId)
    ) {
      res.status(404).json({
        error: "첨부 파일을 찾을 수 없거나 이 계정에서 접근할 수 없습니다.",
      });
      return;
    }
    next();
  });
  const scope = (req: express.Request, res: express.Response) =>
    [
      res.locals.account.id,
      String(req.params.id),
      String(req.params.fileId),
    ] as const;
  router.get(base, (req, res) => {
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit),
      offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (
      Object.keys(req.query).some((k) => !["limit", "offset"].includes(k)) ||
      Array.isArray(req.query.limit) ||
      Array.isArray(req.query.offset) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      res.status(400).json({
        error: "조회 개수는 1~20, 시작 위치는 0 이상의 정수로 입력해 주세요.",
      });
      return;
    }
    res.json(store.listSummaryRuns(...scope(req, res), limit, offset));
  });
  router.post(base, (req, res, next) => {
    const body = req.body,
      key = req.get("idempotency-key");
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => k !== "revision") ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 1 ||
      !key ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(key)
    ) {
      res
        .status(400)
        .json({ error: "저장한 선택 버전과 요청 식별자를 확인해 주세요." });
      return;
    }
    try {
      const result = store.enqueueSummary(
        ...scope(req, res),
        body.revision,
        key,
      );
      res.status(result.replayed ? 200 : 202).json(result);
    } catch (error) {
      if (error instanceof RunError)
        res.status(error.status).json({ error: error.message });
      else next(error);
    }
  });
  router.get(base + "/:runId/artifacts/:format", async (req, res, next) => {
    const id = String(req.params.runId),
      format = String(req.params.format) as ArtifactFormat;
    if (!uuid.test(id) || !ARTIFACT_FORMATS.includes(format)) {
      res.status(404).json({ error: "보관 파일을 찾을 수 없습니다." });
      return;
    }
    try {
      const artifacts = store.summaryRunArtifacts(...scope(req, res), id);
      const artifact = artifacts?.find((a) => a.format === format);
      if (!artifact) {
        res.status(404).json({ error: "이 작업에 보관된 파일이 없습니다." });
        return;
      }
      const bytes = await readArtifact(
        outputFile(store.outputRoot, id, format),
        artifact,
      );
      requireAccount(req, res, () => {
        if (
          !store
            .summaryRunArtifacts(...scope(req, res), id)
            ?.some((a) => a.format === format && a.sha256 === artifact.sha256)
        ) {
          res.status(404).json({ error: "보관 파일을 찾을 수 없습니다." });
          return;
        }
        res.set({
          "Content-Type": ARTIFACT_MIME[format],
          "Content-Disposition": `attachment; filename="office-run-${id}.${format}"`,
        });
        if (format === "html") res.set("Content-Security-Policy", REPORT_CSP);
        res.send(bytes);
      });
    } catch (error) {
      if (error instanceof ArtifactError)
        res.status(409).json({ error: error.message });
      else if (error instanceof RunError)
        res.status(error.status).json({ error: error.message });
      else next(error);
    }
  });
  router.get([base + "/:runId", base + "/:runId/result"], (req, res, next) => {
    const id = String(req.params.runId);
    if (!uuid.test(id)) {
      res.status(404).json({ error: "집계 작업을 찾을 수 없습니다." });
      return;
    }
    try {
      const result = req.path.endsWith("/result")
        ? store.summaryRunResult(...scope(req, res), id)
        : store.summaryRun(...scope(req, res), id);
      if (!result) {
        res.status(404).json({ error: "집계 작업을 찾을 수 없습니다." });
        return;
      }
      res.json(
        req.path.endsWith("/result")
          ? {
              summary: result,
              artifacts: store.summaryRunArtifacts(...scope(req, res), id),
            }
          : result,
      );
    } catch (error) {
      if (error instanceof RunError)
        res.status(error.status).json({ error: error.message });
      else next(error);
    }
  });
  router.post(base + "/:runId/cancel", (req, res) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length) {
      res.status(400).json({ error: "취소 요청 본문을 확인해 주세요." });
      return;
    }
    const id = String(req.params.runId),
      run = uuid.test(id)
        ? store.cancelSummaryRun(...scope(req, res), id)
        : null;
    if (!run) {
      res.status(404).json({ error: "집계 작업을 찾을 수 없습니다." });
      return;
    }
    res.json({ run });
  });
  return router;
}
