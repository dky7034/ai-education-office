import { XMLParser } from "fast-xml-parser";
import { readXlsx } from "../src/attachments.ts";
export async function readWorkbook(bytes: Buffer) {
  const xml = await readXlsx(bytes);
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
  });
  const array = (v: any): any[] =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];
  const sheets = array(
    parser.parse(xml.get("xl/workbook.xml")!).workbook.sheets.sheet,
  );
  return {
    xml,
    sheets: sheets.map((sheet: any, index: number) => {
      const doc = parser.parse(xml.get(`xl/worksheets/sheet${index + 1}.xml`)!);
      const rows = array(doc.worksheet.sheetData?.row).map((row: any) => {
        const values: (string | number | null)[] = [],
          types: string[] = [];
        for (const c of array(row.c)) {
          const letters = String(c["@_r"]).replace(/\d+$/, "");
          let col = 0;
          for (const ch of letters) col = col * 26 + ch.charCodeAt(0) - 64;
          col--;
          const type = c["@_t"];
          types[col] = type;
          values[col] =
            type === "n"
              ? Number(c.v)
              : typeof c.is?.t === "object"
                ? (c.is.t["#text"] ?? "")
                : (c.is?.t ?? "");
        }
        return { values, types };
      });
      return { name: String(sheet["@_name"]), rows };
    }),
  };
}
