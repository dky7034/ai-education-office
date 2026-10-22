import express, { type RequestHandler } from "express";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readXlsx, MAX_FILE_BYTES } from "./attachments.ts";
import { summaryReport, REPORT_CSP } from "./summaryReport.ts";
import { summaryCsv } from "./summaryCsv.ts";
import { surveyQuestions } from "./survey.ts";
import { summarize } from "./summary.ts";
import { tablePreview, PreviewError } from "./tabular.ts";
import { ConflictError, type Store, type Attachment } from "./store.ts";

class OriginalError extends Error {}
async function original(store: Store, item: Attachment) {
  try {
    const path = store.attachmentPath(item.jobId, item.id);
    if ((await stat(path)).size !== item.size || item.size > MAX_FILE_BYTES)
      throw new OriginalError();
    const bytes = await readFile(path);
    if (
      bytes.length !== item.size ||
      createHash("sha256").update(bytes).digest("hex") !== item.sha256
    )
      throw new OriginalError();
    return bytes;
  } catch {
    throw new OriginalError();
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function previewRoutes(store: Store, requireAccount: RequestHandler) {
  const router = express.Router();
  const path = "/:id/attachments/:fileId";
  router.use(path, (req, res, next) => {
    const item =
      uuid.test(String(req.params.id)) && uuid.test(String(req.params.fileId))
        ? store
            .attachments(res.locals.account.id, String(req.params.id))
            ?.find((a) => a.id === req.params.fileId)
        : null;
    if (!item) {
      res.status(404).json({
        error: "첨부 파일을 찾을 수 없거나 이 계정에서 접근할 수 없습니다.",
      });
      return;
    }
    res.locals.attachment = item;
    next();
  });
  const errorResponse = (
    error: unknown,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (error instanceof OriginalError)
      res.status(409).json({
        error:
          "원본 파일이 없거나 무결성 검사에 실패했습니다. 원본을 확인해 주세요.",
      });
    else if (error instanceof PreviewError)
      res.status(422).json({ error: error.message });
    else if (error instanceof ConflictError)
      res.status(409).json({
        error:
          "다른 화면에서 열 선택이 변경되었습니다. 저장 상태를 다시 불러온 뒤 선택해 주세요.",
      });
    else next(error);
  };
  router.get(path + "/preview", async (req, res, next) => {
    const item = res.locals.attachment as Attachment;
    if (
      Object.keys(req.query).some(
        (key) => !["sheetId", "headerRow"].includes(key),
      ) ||
      (req.query.sheetId !== undefined &&
        typeof req.query.sheetId !== "string") ||
      (req.query.headerRow !== undefined &&
        (typeof req.query.headerRow !== "string" ||
          !/^[1-9][0-9]*$/.test(req.query.headerRow)))
    ) {
      res.status(400).json({ error: "시트와 제목 행을 확인해 주세요." });
      return;
    }
    try {
      const selection = store.selection(
        res.locals.account.id,
        item.jobId,
        item.id,
      );
      const data = await original(store, item);
      let xml: Map<string, string> | null = null;
      try {
        if (item.format === "xlsx") xml = await readXlsx(data);
      } catch {
        throw new PreviewError("XLSX 구조를 읽지 못했습니다.");
      }
      const preview = tablePreview(
        item.format,
        data,
        xml,
        (req.query.sheetId as string | undefined) ?? selection?.sheetId,
        req.query.headerRow
          ? Number(req.query.headerRow)
          : (selection?.headerRow ?? 1),
      );
      requireAccount(req, res, () => res.json({ preview, selection }));
    } catch (error) {
      errorResponse(error, res, next);
    }
  });
  router.put(path + "/selection", async (req, res, next) => {
    const item = res.locals.attachment as Attachment,
      body = req.body;
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) =>
          ![
            "sheetId",
            "headerRow",
            "columns",
            "revision",
            "questions",
          ].includes(key),
      ) ||
      typeof body.sheetId !== "string" ||
      body.sheetId.length > 10 ||
      !Number.isInteger(body.headerRow) ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 0 ||
      !Array.isArray(body.columns) ||
      body.columns.length < 1 ||
      body.columns.length > 100 ||
      body.columns.some(
        (c: unknown) =>
          typeof c !== "number" || !Number.isInteger(c) || c < 0 || c >= 100,
      ) ||
      new Set(body.columns).size !== body.columns.length
    ) {
      res.status(400).json({
        error:
          "분석할 열을 1개 이상 선택하고 시트·제목 행·저장 버전을 확인해 주세요.",
      });
      return;
    }
    try {
      const data = await original(store, item);
      let xml: Map<string, string> | null = null;
      try {
        if (item.format === "xlsx") xml = await readXlsx(data);
      } catch {
        throw new PreviewError("XLSX 구조를 읽지 못했습니다.");
      }
      const preview = tablePreview(
        item.format,
        data,
        xml,
        body.sheetId,
        body.headerRow,
      );
      if (
        body.columns.some(
          (c: number) => !preview.columns.some((column) => column.index === c),
        )
      )
        throw new PreviewError("파일에 없는 열은 선택할 수 없습니다.");
      requireAccount(req, res, () => {
        try {
          res.json({
            selection: store.saveSelection(
              res.locals.account.id,
              item.jobId,
              item.id,
              body.revision,
              {
                sheetId: body.sheetId,
                headerRow: body.headerRow,
                columns: body.columns,
                questions: surveyQuestions(body.questions, body.columns),
              },
            ),
          });
        } catch (error) {
          errorResponse(error, res, next);
        }
      });
    } catch (error) {
      errorResponse(error, res, next);
    }
  });
  router.post(
    [path + "/summary", path + "/summary.csv", path + "/summary.html"],
    async (req, res, next) => {
      const csv = req.path.endsWith("/summary.csv");
      const html = req.path.endsWith("/summary.html");
      const item = res.locals.attachment as Attachment,
        body = req.body;
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "revision") ||
        !Number.isSafeInteger(body.revision) ||
        body.revision < 1
      ) {
        res.status(400).json({ error: "저장한 열 선택 버전을 확인해 주세요." });
        return;
      }
      try {
        const selection = store.selection(
          res.locals.account.id,
          item.jobId,
          item.id,
        );
        if (
          !selection ||
          selection.revision !== body.revision ||
          selection.sourceHash !== item.sha256
        )
          throw new ConflictError();
        const data = await original(store, item);
        let xml: Map<string, string> | null = null;
        try {
          if (item.format === "xlsx") xml = await readXlsx(data);
        } catch {
          throw new PreviewError("XLSX 구조를 읽지 못했습니다.");
        }
        const summary = summarize(
          item.format,
          data,
          xml,
          selection,
          csv ? { fullValues: true, frequencyLimit: Infinity } : {},
        );
        const calculatedAt = new Date().toISOString();
        const output =
          csv || html
            ? (csv ? summaryCsv : summaryReport)(summary, {
                jobId: item.jobId,
                fileId: item.id,
                filename: item.name,
                sourceHash: item.sha256,
                revision: selection.revision,
                calculatedAt,
              })
            : null;
        requireAccount(req, res, () => {
          const latest = store.selection(
            res.locals.account.id,
            item.jobId,
            item.id,
          );
          if (
            latest?.revision !== selection.revision ||
            latest.sourceHash !== item.sha256
          ) {
            errorResponse(new ConflictError(), res, next);
            return;
          }
          if (output) {
            res.set({
              "Content-Type": html
                ? "text/html; charset=utf-8"
                : "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="office-summary-${item.id}.${html ? "html" : "csv"}"`,
            });
            if (html) res.set("Content-Security-Policy", REPORT_CSP);
            res.send(output);
            return;
          }
          res.json({
            summary: {
              ...summary,
              revision: selection.revision,
              sourceHash: item.sha256,
              calculatedAt,
            },
          });
        });
      } catch (error) {
        errorResponse(error, res, next);
      }
    },
  );
  return router;
}
