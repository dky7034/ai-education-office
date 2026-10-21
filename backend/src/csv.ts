export function csvText(data: Buffer) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  if (
    !text.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
  )
    throw new Error("올바른 UTF-8 CSV가 아닙니다.");
  return text;
}
export function delimiterOf(text: string) {
  const counts = new Map([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ]);
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (ch === "\n" || ch === "\r") break;
      if (counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
}
export function* csvRows(
  data: Buffer,
  maxColumns = Infinity,
): Generator<string[]> {
  const text = csvText(data),
    delimiter = delimiterOf(text);
  let row: string[] = [],
    fieldStart = 0,
    quoted = false,
    afterQuote = false,
    atStart = true,
    pending = false;
  const field = (end: number) => {
    const raw = text.slice(fieldStart, end);
    row.push(
      raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw,
    );
    atStart = true;
    afterQuote = false;
    if (row.length > maxColumns)
      throw new Error("미리보기는 최대 100열까지 지원합니다.");
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    pending = true;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else {
          quoted = false;
          afterQuote = true;
        }
      }
    } else if (ch === delimiter) {
      field(i);
      fieldStart = i + 1;
    } else if (ch === "\r" || ch === "\n") {
      field(i);
      if (ch === "\r" && text[i + 1] === "\n") i++;
      yield row;
      row = [];
      fieldStart = i + 1;
      pending = false;
    } else if (ch === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else {
      if (ch === '"' || afterQuote)
        throw new Error("CSV 인용 필드가 올바르지 않습니다.");
      atStart = false;
    }
  }
  if (quoted) throw new Error("CSV 인용 필드가 닫히지 않았습니다.");
  if (pending) {
    field(text.length);
    yield row;
  }
}
