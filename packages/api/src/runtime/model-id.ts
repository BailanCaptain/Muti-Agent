/**
 * model id 自由输入的统一格式闸（F027 收录设置首创，F037 日报设置页复用）。
 *
 * 字符集 `[A-Za-z0-9._:/-]`：覆盖三家真实 id 形态（claude-opus-4-7 / gpt-5.4-codex /
 * gemini-3-pro / o3 / org/model）。**收紧不是洁癖**：model id 会进 `spawn(..., {shell:true})`
 * 的 argv（-m <model>），cmd.exe 元字符（& | > ^ " 空格等）可构成命令注入——单一入口
 * （本校验 + sanitize 同口径）堵死，runner 层不接任何未过此闸的字符串。
 *
 * 首字符额外限定字母数字：`-` 开头的"模型 id"（如 `--yolo`）跟在 `-m` 后会被 CLI
 * parser 当 flag 解析（clap/yargs 行为各家不一，不赌单家语义）——真实 model id 全部
 * 字母数字开头，零功能代价杀死整类 flag 注入。
 */

/** model id 自由字符串格式上限（防垃圾/注入；正常 model id 远短于此）。 */
export const MODEL_ID_MAX_LEN = 64

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

export function isValidModelId(v: string): boolean {
  const trimmed = v.trim()
  if (trimmed.length === 0 || trimmed.length > MODEL_ID_MAX_LEN) return false
  return MODEL_ID_RE.test(trimmed)
}
