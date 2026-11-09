import { describe, it, expect } from "vitest";
import { parseEvidence } from "./rowEvidenceProtocol";
const sourceHash = "a".repeat(64);
const evidence = {jobId: "job", fileId: "file", revision: 1, sourceHash, sheetId: "csv", sheetName: "CSV", headerRow: 1, rowNumber: 22,
  totalRows: 30, rowPresent: true, cells: [{index: 0, letter: "A", label: "가상", value: "<script>문자</script>", kind: "value", truncated: false}]};
const parse = (value: unknown) => parseEvidence(value, "job", "file", 1, sourceHash, 22, "csv", 1, [0]);
describe("row evidence response", () => {
  it("accepts scoped text and typed cells", () => expect(parse({evidence})).toEqual(evidence));
  it("rejects wrong scope, source, selection, row and cells outside saved columns", () => {
    for (const change of [{jobId: "else"}, {fileId: "else"}, {revision: 2}, {sourceHash: "b".repeat(64)}, {sheetId: "0"}, {headerRow: 2}, {rowNumber: 23},
      {totalRows: 2}, {totalRows: 20001}, {cells: [{...evidence.cells[0], index: 1}]}]) expect(() => parse({evidence: {...evidence, ...change}})).toThrow();
  });
  it("rejects malformed, oversized and duplicate cells", () => {
    for (const cells of [[], [{...evidence.cells[0], kind: "script"}], [{...evidence.cells[0], value: "x".repeat(2001)}], [evidence.cells[0], evidence.cells[0]]])
      expect(() => parse({evidence: {...evidence, cells}})).toThrow();
  });
});
