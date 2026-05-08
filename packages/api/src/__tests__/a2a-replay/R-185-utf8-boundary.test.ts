import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { decodeChunkedUtf8 } from "../../runtime/utf8-chunk-decoder"
import { generateBoundaryFuzzCases, generateTripleSplitCases } from "./fixtures/R-185-utf8-boundary"

/**
 * F026 P0 Day3 · R-185 UTF-8 chunk 边界 fuzz
 *
 * 证明 harness 可用：对每个 byte boundary 切分都能 round-trip 回原字符串，
 * 且不产生 U+FFFD 替换字符。harness（fixtures/ + test）为 P1+ 的 14 症状
 * 回归提供统一载体。
 */
describe("R-185 · UTF-8 chunk boundary fuzz (P0 harness)", () => {
  it("round-trips multi-byte UTF-8 split at every byte boundary", () => {
    const cases = generateBoundaryFuzzCases()
    assert.ok(cases.length > 0, "fixture must yield cases")
    for (const { input, splits } of cases) {
      const reassembled = decodeChunkedUtf8(splits)
      assert.equal(
        reassembled,
        input,
        `boundary split failed for input=${JSON.stringify(input)}, cutBytes=${splits[0].length}`,
      )
    }
  })

  it("does not produce U+FFFD on any single-byte mid-codepoint split", () => {
    const cases = generateBoundaryFuzzCases()
    for (const { splits } of cases) {
      const out = decodeChunkedUtf8(splits)
      assert.equal(out.includes("�"), false, "no replacement char allowed in any split")
    }
  })

  it("round-trips when chunk count ≥ 3 (triple-split stress)", () => {
    const cases = generateTripleSplitCases()
    for (const { input, splits } of cases) {
      const reassembled = decodeChunkedUtf8(splits)
      assert.equal(
        reassembled,
        input,
        `triple-split failed for input=${JSON.stringify(input)}, lens=[${splits.map((c) => c.length).join(",")}]`,
      )
    }
  })

  it("handles a single whole-string chunk (degenerate no-split case)", () => {
    const s = "你好世界"
    const enc = new TextEncoder().encode(s)
    assert.equal(decodeChunkedUtf8([enc]), s)
  })

  it("handles an empty chunk list by returning empty string", () => {
    assert.equal(decodeChunkedUtf8([]), "")
  })
})
