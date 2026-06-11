/**
 * 德彪 r2 P2 + r4 P2 · taintedSourceFields HTTP 边界运行时校验(共享)。
 *
 * promote / preview / batch-promote 三个 route 共用同一归一化:caller 传入的
 * taintedSourceFields 最终进 V14 detectTaintedDirectQuotes 的 `for (const field of ...)`,
 * 非数组(数字/对象 {length:1})会抛 → 500;非字符串元素会静默跳过 layer3。统一在边界拒。
 *
 * 语义:undefined/null = 未传(放行,跳过 layer3);INVALID = 类型非法(route 返 400);
 * string[] = 合法透传。
 */

export const INVALID_TAINTED = Symbol("invalid-tainted-source-fields")

export function normalizeTaintedSourceFields(
  v: unknown,
): readonly string[] | undefined | typeof INVALID_TAINTED {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return INVALID_TAINTED
  return v as readonly string[]
}
