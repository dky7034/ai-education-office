import { SaxesParser } from "saxes";
import { csvRows } from "./csv.ts";
import { posix } from "node:path";
import express, { type RequestHandler } from "express";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { AttachmentLimitError, ConflictError, type Store } from "./store.ts";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () =>
  new Error(
    "파일 내용이 확장자와 일치하지 않거나 손상되었습니다. CSV는 UTF-8, XLSX는 암호화하지 않은 통합 문서여야 합니다.",
  );

export async function validateFile(
  name: string,
  data: Buffer,
): Promise<"csv" | "xlsx"> {
  if (!data.length) throw invalid();
  if (/\.csv$/i.test(name)) {
    try {
      for (const _row of csvRows(data)) {
        /* Validate all records without retaining them. */
      }
    } catch {
      throw invalid();
    }
    return "csv";
  }
  if (!/\.xlsx$/i.test(name)) throw invalid();
  await readXlsx(data);
  return "xlsx";
}

function worksheetRoot(xml: string) {
  let root = false,
    first = true;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    if (first) {
      first = false;
      root =
        tag.local === "worksheet" &&
        tag.uri === "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    }
  });
  parser.write(xml).close();
  return root;
}

export function readXlsx(data: Buffer): Promise<Map<string, string>> {
  return new Promise<Map<string, string>>((resolve, reject) => {
    yauzl.fromBuffer(
      data,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(invalid());
          return;
        }
        let total = 0,
          count = 0,
          failed = false;
        const names = new Set<string>(),
          xml = new Map<string, string>();
        const needed = [
          "[Content_Types].xml",
          "xl/workbook.xml",
          "_rels/.rels",
          "xl/_rels/workbook.xml.rels",
        ];
        const fail = () => {
          if (!failed) {
            failed = true;
            zip.close();
            reject(invalid());
          }
        };
        zip.on("error", fail);
        zip.on("entry", (entry) => {
          if (failed) return;
          total += entry.uncompressedSize;
          if (
            ++count > 1000 ||
            total > 20 * 1024 * 1024 ||
            names.has(entry.fileName) ||
            entry.isEncrypted() ||
            (needed.includes(entry.fileName) &&
              entry.uncompressedSize > 512 * 1024) ||
            /vbaProject\.bin$/i.test(entry.fileName)
          ) {
            fail();
            return;
          }
          names.add(entry.fileName);
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) {
              fail();
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0,
              crc = 0;
            stream.on("error", fail);
            stream.on("data", (chunk: Buffer) => {
              size += chunk.length;
              crc = crc32(chunk, crc);
              if (size > entry.uncompressedSize || size > 20 * 1024 * 1024) {
                stream.destroy();
                fail();
                return;
              }
              if (
                needed.includes(entry.fileName) ||
                /\.xml$/.test(entry.fileName)
              )
                chunks.push(chunk);
            });
            stream.on("end", () => {
              if (failed) return;
              if (size !== entry.uncompressedSize || crc !== entry.crc32) {
                fail();
                return;
              }
              if (chunks.length) {
                let text: string;
                try {
                  text = new TextDecoder("utf-8", { fatal: true }).decode(
                    Buffer.concat(chunks),
                  );
                } catch {
                  fail();
                  return;
                }
                if (
                  /<!DOCTYPE|<!ENTITY/i.test(text) ||
                  XMLValidator.validate(text) !== true
                ) {
                  fail();
                  return;
                }
                if (
                  needed.includes(entry.fileName) ||
                  entry.fileName === "xl/sharedStrings.xml" ||
                  /^xl\/worksheets\/[^/]+\.xml$/.test(entry.fileName)
                )
                  xml.set(entry.fileName, text);
              }
              zip.readEntry();
            });
          });
        });
        zip.on("end", () => {
          if (failed) return;
          if (
            needed.some((name) => !xml.has(name)) ||
            ![...names].some((name) =>
              /^xl\/worksheets\/[^/]+\.xml$/.test(name),
            )
          ) {
            fail();
            return;
          }
          try {
            const parser = new XMLParser({
              ignoreAttributes: false,
              processEntities: false,
            });
            const types = parser.parse(xml.get("[Content_Types].xml")!).Types;
            const overrides = [types?.Override ?? []].flat();
            const workbook = parser.parse(xml.get("xl/workbook.xml")!).workbook;
            if (
              !overrides.some(
                (item: Record<string, string>) =>
                  item["@_PartName"] === "/xl/workbook.xml" &&
                  item["@_ContentType"] ===
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
              ) ||
              workbook?.["@_xmlns"] !==
                "http://schemas.openxmlformats.org/spreadsheetml/2006/main" ||
              !workbook.sheets?.sheet
            )
              throw invalid();
            const rootRels = [
              parser.parse(xml.get("_rels/.rels")!).Relationships
                ?.Relationship ?? [],
            ].flat();
            if (
              !rootRels.some(
                (item) =>
                  item["@_Type"] ===
                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" &&
                  item["@_Target"]?.replace(/^\//, "") === "xl/workbook.xml" &&
                  item["@_TargetMode"] !== "External",
              )
            )
              throw invalid();
            const relations = [
              parser.parse(xml.get("xl/_rels/workbook.xml.rels")!).Relationships
                ?.Relationship ?? [],
            ].flat();
            for (const sheet of [workbook.sheets.sheet].flat()) {
              const relation = relations.find(
                (item) => item["@_Id"] === sheet["@_r:id"],
              );
              if (
                !relation ||
                relation["@_TargetMode"] === "External" ||
                relation["@_Type"] !==
                  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ||
                typeof relation["@_Target"] !== "string"
              )
                throw invalid();
              const target = relation["@_Target"].startsWith("/")
                ? relation["@_Target"].slice(1)
                : posix.normalize("xl/" + relation["@_Target"]);
              if (
                !/^xl\/worksheets\/[^/]+\.xml$/.test(target) ||
                !xml.has(target) ||
                !worksheetRoot(xml.get(target)!)
              )
                throw invalid();
            }
            resolve(xml);
          } catch {
            fail();
          }
        });
        zip.readEntry();
      },
    );
  });
}

export function attachmentRoutes(store: Store, requireAccount: RequestHandler) {
  const router = express.Router();
  router.use("/:id/attachments", (req, res, next) => {
    if (
      !uuid.test(String(req.params.id)) ||
      !store.detail(res.locals.account.id, String(req.params.id))
    ) {
      res.status(404).json({
        error: "업무를 찾을 수 없거나 이 계정에서 접근할 수 없습니다.",
      });
      return;
    }
    next();
  });
  router.get("/:id/attachments", (req, res) =>
    res.json({
      attachments: store.attachments(
        res.locals.account.id,
        String(req.params.id),
      ),
    }),
  );
  router.post(
    "/:id/attachments",
    express.raw({ type: "application/octet-stream", limit: MAX_FILE_BYTES }),
    async (req, res, next) => {
      let name = "";
      try {
        name = decodeURIComponent(req.get("x-file-name") ?? "");
      } catch {
        /* rejected below */
      }
      const key = req.get("idempotency-key");
      if (
        !key ||
        !/^[A-Za-z0-9_-]{8,100}$/.test(key) ||
        !name ||
        name.length > 180 ||
        /[\x00-\x1f\x7f/\\]/.test(name) ||
        !/\.(csv|xlsx)$/i.test(name) ||
        !Buffer.isBuffer(req.body)
      ) {
        res.status(400).json({
          error:
            "파일명(최대 180자), XLSX·CSV 확장자와 요청 식별자를 확인해 주세요.",
        });
        return;
      }
      let format: "csv" | "xlsx";
      try {
        format = await validateFile(name, req.body);
      } catch (error) {
        res.status(400).json({
          error:
            error instanceof Error
              ? error.message
              : "파일을 검증하지 못했습니다.",
        });
        return;
      }
      // Validation is asynchronous; recheck session/account before persisting.
      requireAccount(req, res, () => {
        try {
          const result = store.saveAttachment(
            res.locals.account.id,
            String(req.params.id),
            key,
            name,
            format,
            req.body,
          );
          res.status(result.replayed ? 200 : 201).json(result);
        } catch (error) {
          if (error instanceof AttachmentLimitError)
            res.status(409).json({
              error: "업무당 파일은 최대 5개까지 첨부할 수 있습니다.",
            });
          else if (error instanceof ConflictError)
            res.status(409).json({
              error: "같은 요청 식별자로 다른 파일을 저장할 수 없습니다.",
            });
          else next(error);
        }
      });
    },
  );
  router.get("/:id/attachments/:fileId", async (req, res) => {
    const item = uuid.test(String(req.params.fileId))
      ? store
          .attachments(res.locals.account.id, String(req.params.id))
          ?.find((file) => file.id === req.params.fileId)
      : null;
    if (!item) {
      res.status(404).json({ error: "첨부 파일을 찾을 수 없습니다." });
      return;
    }
    try {
      const data = await readFile(store.attachmentPath(item.jobId, item.id));
      if (
        data.length !== item.size ||
        createHash("sha256").update(data).digest("hex") !== item.sha256
      )
        throw invalid();
      res.set({
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="attachment.${item.format}"; filename*=UTF-8''${encodeURIComponent(item.name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`,
        "Content-Length": String(data.length),
      });
      res.send(data);
    } catch {
      res.status(409).json({
        error:
          "원본 파일이 없거나 무결성 검사에 실패했습니다. 관리자에게 확인해 주세요.",
      });
    }
  });
  return router;
}
