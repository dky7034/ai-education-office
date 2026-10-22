// Fixed decimal arithmetic avoids binary floating-point loss and JSON non-finite numbers.
// Input supports up to 100 integer and 100 fractional places after normalization.
const SCALE_PLACES = 100;
export const DECIMAL_SCALE = 10n ** BigInt(SCALE_PLACES);
const DECIMAL = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
export const NUMERIC_RULE =
  "숫자 모양의 일반 값만 계산합니다(부호·소수점·지수 표기 지원). 쉼표·통화·퍼센트·날짜 문자는 변환하지 않습니다. 정규화 후 정수부·소수부 각각 100자리까지 지원하며 범위 밖 값은 별도 제외합니다. 합계는 정확한 십진수, 평균은 소수점 이하 최대 6자리로 반올림합니다(7번째 자리가 5 이상이면 절댓값이 커지는 방향). XLSX 날짜 일련번호·숫자 모양 식별자도 포함될 수 있으며 평가 점수가 아닙니다.";
export function parseDecimal(
  value: string,
): bigint | "nonNumeric" | "outOfRange" {
  const match = DECIMAL.exec(value);
  if (!match) return "nonNumeric";
  const integer = match[2] ?? "",
    fraction = match[3] ?? match[4] ?? "";
  const raw = integer + fraction;
  const withoutLeading = raw.replace(/^0+/, "");
  const digits = withoutLeading.replace(/0+$/, "");
  if (!digits) return 0n;
  const exponent = Number(match[5] ?? "0");
  if (!Number.isSafeInteger(exponent)) return "outOfRange";
  const position =
    integer.length + exponent - (raw.length - withoutLeading.length);
  if (position > 100 || digits.length - position > 100) return "outOfRange";
  const scaled =
    BigInt(digits) * 10n ** BigInt(SCALE_PLACES + position - digits.length);
  return match[1] === "-" ? -scaled : scaled;
}
function decimal(value: bigint, places = SCALE_PLACES): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(places + 1, "0");
  const fraction = digits.slice(-places).replace(/0+$/, "");
  return (
    (negative ? "-" : "") +
    digits.slice(0, -places) +
    (fraction ? "." + fraction : "")
  );
}
export function numericAccumulator() {
  let count = 0,
    nonNumericCount = 0,
    outOfRangeCount = 0;
  let sum = 0n,
    min: bigint | null = null,
    max: bigint | null = null;
  return {
    add(value: string) {
      const parsed = parseDecimal(value);
      if (parsed === "nonNumeric") {
        nonNumericCount++;
        return;
      }
      if (parsed === "outOfRange") {
        outOfRangeCount++;
        return;
      }
      count++;
      sum += parsed;
      if (min === null || parsed < min) min = parsed;
      if (max === null || parsed > max) max = parsed;
    },
    result() {
      const divisor = BigInt(count || 1) * DECIMAL_SCALE;
      const rounded =
        ((sum < 0n ? -sum : sum) * 1000000n + divisor / 2n) / divisor;
      return {
        count,
        nonNumericCount,
        outOfRangeCount,
        sum: count ? decimal(sum) : null,
        mean: count ? decimal(sum < 0n ? -rounded : rounded, 6) : null,
        min: min === null ? null : decimal(min),
        max: max === null ? null : decimal(max),
      };
    },
  };
}
