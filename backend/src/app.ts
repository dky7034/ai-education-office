import { aiRoutes } from "./aiRoutes.ts";
import type { AiConfig } from "./aiStore.ts";
import { JOB_FILTERS, type JobFilter } from "./jobSearch.ts";
import express, { type ErrorRequestHandler } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ASSIGNEES, ConflictError, type Kind, type Store } from "./store.ts";
import { runRoutes } from "./runRoutes.ts";
import { previewRoutes } from "./previewRoutes.ts";
import { attachmentRoutes } from "./attachments.ts";
import { accountAuth } from "./auth.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApp(
  store: Store,
  options: {
    frontendDir?: string;
    secureCookies?: boolean;
    authRateLimit?: number;
    aiConfig?: AiConfig;
  } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/api/health", (_req, res) =>
    res.json({ status: "ok", executionMode: "not_connected" }),
  );
  app.use("/api", (_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });
  // No CORS: cross-site forms cannot send this header and browser fetch needs a preflight.
  app.use("/api", (req, res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const upload =
        req.method === "POST" &&
        /^\/jobs\/[0-9a-f-]{36}\/attachments$/i.test(req.path);
      if (
        req.get("x-office-request") !== "1" ||
        !(upload
          ? req.is("application/octet-stream")
          : req.is("application/json"))
      ) {
        res.status(403).json({
          error: "이 화면에서 보낸 올바른 형식의 요청만 처리할 수 있습니다.",
        });
        return;
      }
      const origin = req.get("origin");
      if (origin) {
        try {
          if (new URL(origin).host !== req.get("host")) throw new Error();
        } catch {
          res
            .status(403)
            .json({ error: "다른 사이트에서 보낸 요청은 처리할 수 없습니다." });
          return;
        }
      }
    }
    next();
  });
  app.use("/api", express.json({ limit: "32kb", strict: true }));
  const auth = accountAuth(
    store,
    options.secureCookies ?? false,
    options.authRateLimit,
  );
  app.use("/api/auth", auth.router);
  app.use("/api/jobs", auth.requireAccount);
  app.use("/api/jobs", attachmentRoutes(store, auth.requireAccount));
  app.use("/api/jobs", aiRoutes(store, options.aiConfig));
  app.use("/api/jobs", runRoutes(store, auth.requireAccount));
  app.use("/api/jobs", previewRoutes(store, auth.requireAccount));
  app.get("/api/jobs/ai-office", (req, res) => {
    if (Object.keys(req.query).length) { res.status(400).json({ error: "AI 현황은 계정 전체를 조회합니다. 조건을 지정하지 마세요." }); return; }
    res.json(store.aiOfficeState(res.locals.account.id));
  });
  app.get("/api/jobs/office", (req, res) => {
    if (Object.keys(req.query).length) {
      res
        .status(400)
        .json({
          error:
            "오피스 현황은 계정 전체를 조회합니다. 검색 조건을 지정하지 마세요.",
        });
      return;
    }
    res.json(store.officeState(res.locals.account.id));
  });
  app.get("/api/jobs", (req, res) => {
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    const offset =
      req.query.offset === undefined ? 0 : Number(req.query.offset);
    const q = req.query.q === undefined ? "" : req.query.q,
      status = req.query.status === undefined ? "all" : req.query.status;
    if (
      typeof q !== "string" ||
      q.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(q) ||
      typeof status !== "string" ||
      !JOB_FILTERS.includes(status as JobFilter) ||
      Object.keys(req.query).some(
        (key) => !["limit", "offset", "q", "status"].includes(key),
      )
    ) {
      res.status(400).json({
        error:
          "검색어는 제어 문자 없이 100자 이하, 상태는 지원하는 필터로 지정해 주세요.",
      });
      return;
    }
    if (
      (req.query.limit !== undefined && typeof req.query.limit !== "string") ||
      (req.query.offset !== undefined &&
        typeof req.query.offset !== "string") ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      Array.isArray(req.query.limit) ||
      Array.isArray(req.query.offset)
    ) {
      res.status(400).json({
        error: "조회 개수는 1~100, 시작 위치는 0 이상의 정수여야 합니다.",
      });
      return;
    }
    res.json(
      store.list(res.locals.account.id, limit, offset, {
        q: q.trim(),
        status: status as JobFilter,
      }),
    );
  });
  app.post("/api/jobs", (req, res) => {
    const body = req.body;
    const key = req.get("idempotency-key");
    if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
      res.status(400).json({ error: "유효한 요청 식별자가 필요합니다." });
      return;
    }
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (k) => !["kind", "title", "instructions"].includes(k),
      ) ||
      typeof body.kind !== "string" ||
      !Object.hasOwn(ASSIGNEES, body.kind) ||
      typeof body.title !== "string" ||
      typeof body.instructions !== "string"
    ) {
      res
        .status(400)
        .json({ error: "업무 종류, 제목, 요청 내용을 확인해 주세요." });
      return;
    }
    const title = body.title.trim(),
      instructions = body.instructions.trim();
    if (
      title.length < 2 ||
      title.length > 100 ||
      instructions.length < 1 ||
      instructions.length > 5000
    ) {
      res.status(400).json({
        error: "제목은 2~100자, 요청 내용은 1~5,000자로 입력해 주세요.",
      });
      return;
    }
    try {
      const result = store.create(
        res.locals.owner,
        key,
        {
          kind: body.kind as Kind,
          title,
          instructions,
        },
        res.locals.account.id,
      );
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      if (error instanceof ConflictError) {
        res.status(409).json({
          error:
            "같은 요청 식별자로 다른 내용을 저장할 수 없습니다. 입력 내용을 변경한 뒤 다시 시도해 주세요.",
        });
        return;
      }
      throw error;
    }
  });
  app.get(["/api/jobs/:id", "/api/jobs/:id/events"], (req, res) => {
    const id = String(req.params.id);
    const detail = uuid.test(id)
      ? store.detail(res.locals.account.id, id)
      : null;
    if (!detail) {
      res.status(404).json({
        error: "업무를 찾을 수 없거나 이 계정에서 접근할 수 없습니다.",
      });
      return;
    }
    res.json(req.path.endsWith("/events") ? { events: detail.events } : detail);
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "지원하지 않는 API입니다." }),
  );
  if (
    options.frontendDir &&
    existsSync(join(options.frontendDir, "index.html"))
  )
    app.use(express.static(options.frontendDir));
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    const status =
      error.type === "entity.too.large"
        ? 413
        : error.type === "entity.parse.failed"
          ? 400
          : 500;
    if (status === 500) console.error("업무 API 처리 중 오류가 발생했습니다.");
    res.status(status).json({
      error:
        status === 413
          ? "요청 내용이 너무 큽니다."
          : status === 400
            ? "올바른 JSON 요청이 아닙니다."
            : "업무를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    });
  };
  app.use(onError);
  return app;
}
