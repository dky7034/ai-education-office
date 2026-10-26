import { expect, it } from "vitest";
import { parseAiReview, parseAiReviewWrite } from "./aiReviewProtocol";
const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", hash = "a".repeat(64);
const decision = { id, runId: id, reviewerId: id, decision: "approved", comment: "합성 의견", targetHash: hash, valid: true, decidedAt: "2026-10-26T00:00:00Z" };
const state = { targetHash: hash, resultHash: hash, reviewable: true, problem: null, decision };
it("AI 검토는 대상·유효성·이력을 일관되게 해석한다", () => {
  expect(parseAiReview(state, id).decision?.valid).toBe(true);
  expect(parseAiReview({ targetHash: null, resultHash: null, reviewable: false, problem: "손상", decision: { ...decision, valid: false } }, id).reviewable).toBe(false);
  expect(parseAiReviewWrite({ decision, replayed: true }, id).replayed).toBe(true);
});
it("AI 검토의 잘못된 실행·결정·플래그·시간·의견을 거부한다", () => {
  for (const patch of [{ runId: "other" }, { valid: false }, { decision: "other" }, { comment: " x " }, { decidedAt: "bad" }])
    expect(() => parseAiReview({ ...state, decision: { ...decision, ...patch } }, id)).toThrow();
  for (const patch of [{ reviewable: false }, { problem: "error" }, { resultHash: null }, { targetHash: [] }])
    expect(() => parseAiReview({ ...state, ...patch }, id)).toThrow();
  expect(() => parseAiReviewWrite({ decision, replayed: "yes" }, id)).toThrow();
});
