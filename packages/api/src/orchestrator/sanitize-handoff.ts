// F018 AC4: sanitize handoff digest body before injecting into session prompt.
// Four defenses (参照 clowder-ai SessionBootstrap.ts:24-30):
//   1. Strip ASCII control chars (except \n) — prevents ANSI escapes
//   2. Strip zero-width Unicode (ZWSP/ZWNJ/ZWJ/BOM) — 否则 "IMPORTANT\u200B:" 能绕过行首匹配
//   3. Strip forged [/Previous Session Summary] — prevents closing-tag escape
//   4. Remove entire lines starting with directive keywords (IMPORTANT/INSTRUCTION/SYSTEM/NOTE)

export function sanitizeHandoffBody(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the explicit purpose
      .replace(/[\x00-\x09\x0b-\x1f]/g, "")
      .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "")
      .replace(/\[\/Previous Session Summary\]/g, "")
      .replace(/^\s*(IMPORTANT|INSTRUCTION|SYSTEM|NOTE)[:：].*$/gim, "")
      .split("\n")
      .filter((line, i, arr) => {
        if (line !== "") return true
        if (i === 0 || i === arr.length - 1) return false
        return arr[i - 1] !== ""
      })
      .join("\n")
      .trim()
  )
}
