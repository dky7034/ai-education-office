import express from "express";
import type { Store } from "./store.ts";
import { AiError, type AiConfig } from "./aiStore.ts";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function aiRoutes(store: Store, config?: AiConfig) {
  const router = express.Router(), base = "/:id/ai-runs";
  router.use(base, (req, res, next) => {
    if (!uuid.test(String(req.params.id)) || !store.detail(res.locals.account.id, String(req.params.id))) {
      res.status(404).json({ error: "업무를 찾을 수 없거나 이 계정에서 접근할 수 없습니다." }); return;
    }
    next();
  });
  router.get(base, (req, res) => {
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (Object.keys(req.query).some((key) => !["limit", "offset"].includes(key))
      || (req.query.limit !== undefined && typeof req.query.limit !== "string")
      || (req.query.offset !== undefined && typeof req.query.offset !== "string")
      || !Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(offset) || offset < 0) {
      res.status(400).json({ error: "조회 개수는 1~20, 시작 위치는 0 이상의 정수여야 합니다." }); return;
    }
    res.json({ ...store.listAiRuns(res.locals.account.id, String(req.params.id), limit, offset),
      capability: { configured: !!config, mode: config?.mode ?? "disabled" } });
  });
  const handle = (fn: express.RequestHandler): express.RequestHandler => (req, res, next) => {
    try { fn(req, res, next); }
    catch (error) { if (error instanceof AiError) res.status(error.status).json({ error: error.message }); else next(error); }
  };
  router.post(base, handle((req, res) => {
    const key = req.get("idempotency-key");
    if (Object.keys(req.query).length || !req.body || Array.isArray(req.body) || Object.keys(req.body).length
      || !key || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
      res.status(400).json({ error: "빈 요청 본문과 유효한 요청 식별자가 필요합니다. AI 입력은 저장된 업무에서 가져옵니다." }); return;
    }
    const result = store.enqueueAi(res.locals.account.id, String(req.params.id), key, config);
    if (!result) { res.status(404).json({ error: "업무를 찾을 수 없습니다." }); return; }
    res.status(result.replayed ? 200 : 202).json(result);
  }));
  router.get([base + "/:runId", base + "/:runId/result"], handle((req, res) => {
    if (Object.keys(req.query).length) { res.status(400).json({ error: "조회 조건을 지정하지 마세요." }); return; }
    const id = String(req.params.runId);
    const value = uuid.test(id) ? (req.path.endsWith("/result")
      ? store.aiResult(res.locals.account.id, String(req.params.id), id)
      : store.aiRun(res.locals.account.id, String(req.params.id), id)) : null;
    if (!value) { res.status(404).json({ error: "AI 실행 기록을 찾을 수 없습니다." }); return; }
    res.json(value);
  }));
  router.post(base + "/:runId/cancel", handle((req, res) => {
    if (Object.keys(req.query).length || !req.body || Array.isArray(req.body) || Object.keys(req.body).length) {
      res.status(400).json({ error: "취소 요청 본문을 확인해 주세요." }); return;
    }
    const id = String(req.params.runId), run = uuid.test(id)
      ? store.cancelAi(res.locals.account.id, String(req.params.id), id) : null;
    if (!run) { res.status(404).json({ error: "AI 실행 기록을 찾을 수 없습니다." }); return; }
    res.status(run.status === "cancelling" ? 202 : 200).json({ run });
  }));
  return router;
}
