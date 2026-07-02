/**
 * F031 AC4 · 流式内容累计器：push 原子地"追加并返回 append 前 offset"。
 *
 * offset 是客户端 delta 幂等判定的基准（flush 时刻 === 追加 / < 重复丢弃 / > 空洞
 * 触发 catch-up），必须是 append **前**的长度快照。把捕获和追加收进一个调用，
 * 结构上杜绝"先 += 后取长度"的错序（Design Gate r3 德彪实现要点：改造前
 * message-service 三处 emit 源都是先 append 后 emit）。
 */
export class StreamAccumulator {
  private value = ""

  /** 追加一段，返回 append 前 offset（emit payload 直接用返回值）。 */
  push(chunk: string): number {
    const offset = this.value.length
    this.value += chunk
    return offset
  }

  get current(): string {
    return this.value
  }

  /** 整体重置（retry 清空 / catch 路径回填）；后续 push offset 以新值为基准。 */
  set(value: string) {
    this.value = value
  }
}
