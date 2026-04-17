// F018 AC4: sanitize handoff digest body before injecting into session prompt.
// Four defenses (参照 clowder-ai SessionBootstrap.ts:24-30):
//   1. Strip ASCII control chars (except \n) — prevents ANSI escapes
//   2. Strip invisible format chars (ZWSP/ZWNJ/ZWJ + WORD JOINER + invisible ops + BOM) —
//      否则 "IMPORTANT\u200B:" / "SYSTEM\u2060:" 能绕过行首匹配
//   3. Strip forged SessionBootstrap wrapper closing tags — 防 body 伪造任一闭合段
//      逃逸出 reference-only 边界。覆盖 Previous Session Summary / Thread Memory /
//      Task Snapshot / Session Recall — Available Tools 所有 Bootstrap 区段。
//   4. Remove entire lines starting with directive keywords (IMPORTANT/INSTRUCTION/SYSTEM/NOTE)
//      — 关键词与冒号之间允许任意空白（防 "SYSTEM : payload" 绕过）

export function sanitizeHandoffBody(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the explicit purpose
      .replace(/[\x00-\x09\x0b-\x1f]/g, "")
      // Alternation (not character class) to avoid biome noMisleadingCharacterClass on ZWJ.
      // Strip list: ZWSP/ZWNJ/ZWJ (200B-200D) + LRM/RLM (200E/200F) + WORD JOINER / invisible ops (2060-2064)
      // + bidi isolates (2066-2069) + BOM (FEFF).
      .replace(
        /\u200B|\u200C|\u200D|\u200E|\u200F|\u2060|\u2061|\u2062|\u2063|\u2064|\u2066|\u2067|\u2068|\u2069|\uFEFF/g,
        "",
      )
      // Strip all Bootstrap/Auto-resume wrapper closing tags to prevent body from
      // terminating its section early and leaking into the next (reference-only boundary).
      .replace(
        /\[\/(?:Previous Session Summary|Thread Memory|Task Snapshot|Session Recall — Available Tools|Auto-resume Context|SOP Bookmark)\]/g,
        "",
      )
      .replace(/^\s*(IMPORTANT|INSTRUCTION|SYSTEM|NOTE)\s*[:：].*$/gim, "")
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
