/**
 * F026 P0 Day3 · R-185 fixture 生成器
 *
 * 对每个样本的每个 byte boundary 切一刀，产出 (input, splits) 用例数组。
 * 3-byte 中文 / 4-byte emoji surrogate pair / 中英混排 / ASCII baseline 全覆盖。
 */
export function generateBoundaryFuzzCases(): Array<{ input: string; splits: Uint8Array[] }> {
  const samples = [
    "你好，世界", // 3-byte 中文
    "范德彪 review 了 PR：✅ 通过", // 中英混排 + 3-byte emoji
    "𝓗𝓮𝓵𝓵𝓸", // 4-byte surrogate pair (SMP)
    "abc", // ascii baseline
    "🎉🐾👍", // 纯 emoji surrogate
  ]
  const cases: Array<{ input: string; splits: Uint8Array[] }> = []
  const enc = new TextEncoder()
  for (const s of samples) {
    const bytes = enc.encode(s)
    for (let cut = 1; cut < bytes.length; cut++) {
      cases.push({
        input: s,
        splits: [bytes.slice(0, cut), bytes.slice(cut)],
      })
    }
  }
  return cases
}

/**
 * 三段切分的极端场景：每两个边界各切一刀，构造 chunk 数 ≥ 3 的用例。
 * 用来证明 decoder 在多 chunk 累积时不会把中间 chunk 的半字节结果吐出去。
 */
export function generateTripleSplitCases(): Array<{ input: string; splits: Uint8Array[] }> {
  const samples = ["你好世界", "🎉 done 🐾"]
  const cases: Array<{ input: string; splits: Uint8Array[] }> = []
  const enc = new TextEncoder()
  for (const s of samples) {
    const bytes = enc.encode(s)
    if (bytes.length < 3) continue
    for (let a = 1; a < bytes.length - 1; a++) {
      for (let b = a + 1; b < bytes.length; b++) {
        cases.push({
          input: s,
          splits: [bytes.slice(0, a), bytes.slice(a, b), bytes.slice(b)],
        })
      }
    }
  }
  return cases
}
