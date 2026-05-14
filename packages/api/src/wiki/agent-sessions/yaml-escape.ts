/**
 * F027 P8 范-r2 P2-2 修：抽出共享 YAML escape helper
 * 真相源：YAML 1.2 spec 7.4.2 plain scalar + 1.1 boolean / null 兜底
 *
 * 之前 ledger-writer.ts 和 yearly-pack.ts 各有一份 escapeYamlString，后者覆盖更窄
 * （roomId='Null' / alias='[a]' 在 yearly-pack frontmatter 不被 quote）→ YAML 解析
 * 错为 null / flow seq。本文件做 single source of truth，两边都引用。
 *
 * 拒绝 plain scalar 的全集：
 *   - control / quote / : # 等
 *   - flow indicators [ ] { } , ` 起头
 *   - YAML 1.2 null literal: null Null NULL ~ + 空字符串
 *   - YAML 1.1 boolean (老 parser 接): true/True/TRUE/false/False/FALSE/yes/Yes/YES/
 *     no/No/NO/on/On/ON/off/Off/OFF/y/Y/n/N
 *   - special floats: .nan/.NaN/.NAN/.inf/.Inf/.INF (含 +/- 前缀)
 *   - 数字开头（防被解析数值）
 *   - 段首特殊字符 - ? ! & * | > % @ ` 等
 *   - leading / trailing whitespace
 */

export function escapeYamlString(s: string): string {
  if (s.length === 0) return '""'
  // 控制字符（避开 biome noControlCharactersInRegex）
  let hasControl = false
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) {
      hasControl = true
      break
    }
  }
  const containsRiskyChar =
    /[:#"'\n\r\t\\]/.test(s) ||
    /[,[\]{}]/.test(s) || // YAML flow indicators
    hasControl
  const wsEdge = /^[\s]/.test(s) || /[\s]$/.test(s)
  const leadingSpecial = /^[-?!&*|>%@`]/.test(s)
  const numericLike = /^[0-9]/.test(s)
  const yamlNull = /^(null|Null|NULL|~)$/.test(s)
  const yamlBoolish =
    /^(true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF|y|Y|n|N)$/.test(s)
  const yamlSpecialNum = /^[-+]?\.(?:nan|NaN|NAN|inf|Inf|INF)$/.test(s)
  const needsQuote =
    containsRiskyChar ||
    wsEdge ||
    leadingSpecial ||
    numericLike ||
    yamlNull ||
    yamlBoolish ||
    yamlSpecialNum
  if (!needsQuote) return s
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
