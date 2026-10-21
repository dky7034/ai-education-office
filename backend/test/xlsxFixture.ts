import { ZipFile } from "yazl";
export async function xlsxFixture(extra: Record<string, string | Buffer> = {}) {
  const parts: Record<string, string | Buffer> = {
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    "_rels/.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml":
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="합성 설문" sheetId="1" r:id="r1"/><sheet name="두 번째 시트" sheetId="2" r:id="r2" state="hidden"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    "xl/sharedStrings.xml":
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>만족도</t></si><si><r><t>가상</t></r><r><t> 의견</t></r></si></sst>',
    "xl/worksheets/sheet1.xml":
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>의견</t></is></c></row><row r="2"><c r="A2"><v>5</v></c><c r="B2"><f>SUM(A2:A2)</f><v>5</v></c><c r="C2" t="s"><v>1</v></c></row><row r="4"><c r="A4" t="b"><v>1</v></c><c r="B4"><v>45292</v></c><c r="C4" t="e"><v>#N/A</v></c></row></sheetData></worksheet>',
    "xl/worksheets/sheet2.xml":
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>제목</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>다른 합성 자료</t></is></c></row></sheetData></worksheet>',
    ...extra,
  };
  const zip = new ZipFile();
  for (const [name, data] of Object.entries(parts))
    zip.addBuffer(Buffer.from(data), name);
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  zip.end();
  return result;
}
