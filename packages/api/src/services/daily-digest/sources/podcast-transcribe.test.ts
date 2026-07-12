import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  type EpisodeRecord,
  type PodcastEpisodeRef,
  SEGMENT_SEC,
  createPodcastTranscriber,
  episodeCacheKey,
  readEpisodeRecord,
  sanitizeDigestText,
} from "./podcast-transcribe"

/** 全 mock 单测：无真网、无真 ffmpeg、缓存盘用临时目录（Iron Law §1：测试用临时实例） */

let baseDir: string
beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "podcast-test-"))
})
afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true })
})

const EP: PodcastEpisodeRef = {
  episodeUrl: "https://www.xiaoyuzhoufm.com/episode/abc123",
  enclosureUrl: "https://media.xyzcdn.net/648b/audio1.m4a",
  title: "对谈某某：AI 下半场",
  podcast: "42章经",
  publishedAt: "2026-07-08T13:30:00.000Z",
  durationSec: 3020,
}

function writeRecord(rec: Partial<EpisodeRecord> & { enclosureUrl: string }): void {
  const key = episodeCacheKey(rec.enclosureUrl)
  fs.mkdirSync(path.join(baseDir, "transcripts"), { recursive: true })
  fs.writeFileSync(
    path.join(baseDir, "transcripts", `${key}.json`),
    JSON.stringify({
      episodeUrl: EP.episodeUrl,
      title: EP.title,
      podcast: EP.podcast,
      publishedAt: EP.publishedAt,
      durationSec: EP.durationSec,
      transcript: "既有转写",
      digestZh: null,
      transcribedAt: "2026-07-09T00:00:00.000Z",
      digestedAt: null,
      ...rec,
    }),
  )
}

function webStreamOf(bytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(Math.min(bytes, 1024)).fill(1)
  return new ReadableStream({
    start(c) {
      c.enqueue(chunk)
      c.close()
    },
  })
}

/** 伪 Response：downloadAudio（manual redirect）用 status/ok/headers.get/body */
function audioResponse(
  opts: { status?: number; declaredBytes?: number; location?: string } = {},
): Response {
  const status = opts.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) =>
        k === "content-length"
          ? String(opts.declaredBytes ?? 1024)
          : k === "location"
            ? (opts.location ?? null)
            : null,
    },
    body: status >= 300 ? null : webStreamOf(opts.declaredBytes ?? 1024),
  } as unknown as Response
}

function sttResponse(text: string, status = 200): Response {
  return {
    ok: status < 300,
    status,
    text: async () => (status < 300 ? JSON.stringify({ text }) : `{"error":"quota"}`),
  } as unknown as Response
}

interface MockState {
  audioCalls: string[]
  sttCalls: number
  spawnArgs: string[][]
  runnerCalls: number
}

function freshState(): MockState {
  return { audioCalls: [], sttCalls: 0, spawnArgs: [], runnerCalls: 0 }
}

function makeDeps(
  state: MockState,
  overrides: {
    sttText?: string
    sttStatus?: number
    /** 第 N 次 STT 调用的 status 序列（段级缓存红测用）；缺省全用 sttStatus */
    sttStatusSeq?: number[]
    runnerOk?: boolean
    runnerText?: string
    spawnFail?: "enoent" | "exit1"
    /** segment muxer 产出段数（真 ffmpeg 按 EOF 决定；mock 由用例控制），默认 1 */
    segCount?: number
    /** 每段写出的字节数（段大小后验红测用），默认 8 */
    segBytes?: number
  } = {},
) {
  const spawnImpl = ((cmd: string, args: string[]) => {
    state.spawnArgs.push(args)
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter
      kill: () => void
    }
    child.stderr = new EventEmitter()
    child.kill = () => {}
    process.nextTick(() => {
      if (overrides.spawnFail === "enoent") {
        const err = new Error("spawn ffmpeg ENOENT") as NodeJS.ErrnoException
        err.code = "ENOENT"
        child.emit("error", err)
        return
      }
      if (overrides.spawnFail === "exit1") {
        child.stderr.emit("data", "Invalid data found")
        child.emit("close", 1)
        return
      }
      // segment muxer：outPattern 是最后一个参数（<key>-seg%03d.mp3），按 segCount 写段
      const pattern = args[args.length - 1]
      const n = overrides.segCount ?? 1
      for (let i = 0; i < n; i++) {
        const p = pattern.replace("%03d", String(i).padStart(3, "0"))
        fs.writeFileSync(p, Buffer.alloc(overrides.segBytes ?? 8, 1))
      }
      child.emit("close", 0)
    })
    return child
  }) as unknown as typeof import("node:child_process").spawn

  let sttCallIdx = 0
  return {
    sttApiKey: "gsk_test",
    baseDir,
    audioFetchImpl: (async (url: string | URL | Request) => {
      state.audioCalls.push(String(url))
      return audioResponse()
    }) as unknown as typeof fetch,
    sttFetchImpl: (async () => {
      state.sttCalls++
      const status = overrides.sttStatusSeq?.[sttCallIdx++] ?? overrides.sttStatus ?? 200
      return sttResponse(overrides.sttText ?? "转写全文内容", status)
    }) as unknown as typeof fetch,
    runner: {
      runPrompt: async () => {
        state.runnerCalls++
        return {
          ok: overrides.runnerOk ?? true,
          text: overrides.runnerText ?? "• 要点一：AI 下半场看应用\n• 要点二：嘉宾判断明年爆发",
          durationMs: 5,
        }
      },
    },
    spawnImpl,
  }
}

describe("sanitizeDigestText", () => {
  it("剥 HTML/控制字符，行数 ≤6，总长 ≤600", () => {
    const dirty = `• A<script>x</script>bell\n${"• 很长的行\n".repeat(9)}`
    const out = sanitizeDigestText(dirty)
    assert.ok(!out.includes("<"))
    assert.ok(!out.includes(""))
    assert.ok(out.includes("bell"))
    assert.equal(out.split("\n").length, 6)
    assert.ok(sanitizeDigestText("x".repeat(2000)).length <= 600)
  })

  it("空输入/纯标签输入 → 空串", () => {
    assert.equal(sanitizeDigestText(""), "")
    assert.equal(sanitizeDigestText("<p></p>"), "")
  })
})

describe("ensureDigest 缓存分层", () => {
  it("缓存 digestZh 命中：零网络零 spawn 秒回", async () => {
    writeRecord({
      enclosureUrl: EP.enclosureUrl,
      digestZh: "• 已有摘要",
      digestedAt: "2026-07-09T01:00:00.000Z",
    })
    const state = freshState()
    const t = createPodcastTranscriber(makeDeps(state))
    const rec = await t.ensureDigest(EP)
    assert.equal(rec.digestZh, "• 已有摘要")
    assert.equal(state.audioCalls.length, 0)
    assert.equal(state.sttCalls, 0)
    assert.equal(state.spawnArgs.length, 0)
    assert.equal(state.runnerCalls, 0)
  })

  it("有 transcript 缺 digest：只补提炼，不重转写（配额保护核心合同）", async () => {
    writeRecord({ enclosureUrl: EP.enclosureUrl, transcript: "既有转写全文" })
    const state = freshState()
    const t = createPodcastTranscriber(makeDeps(state))
    const rec = await t.ensureDigest(EP)
    assert.equal(state.sttCalls, 0)
    assert.equal(state.audioCalls.length, 0)
    assert.equal(state.runnerCalls, 1)
    assert.ok(rec.digestZh?.includes("要点一"))
    assert.equal(rec.transcript, "既有转写全文")
  })

  it("提炼失败：抛错但 transcript 已落盘——二跑不再碰 STT", async () => {
    const state = freshState()
    const t = createPodcastTranscriber(makeDeps(state, { runnerOk: false }))
    await assert.rejects(() => t.ensureDigest(EP), /提炼 LLM 失败/)
    assert.equal(state.sttCalls, 1)
    const cached = readEpisodeRecord(baseDir, episodeCacheKey(EP.enclosureUrl))
    assert.equal(cached?.transcript, "转写全文内容")
    assert.equal(cached?.digestZh, null)

    const state2 = freshState()
    const t2 = createPodcastTranscriber(makeDeps(state2))
    const rec = await t2.ensureDigest(EP)
    assert.equal(state2.sttCalls, 0) // 不重转写
    assert.ok(rec.digestZh)
  })

  it("段级缓存（德彪 r1 P2-4 红测）：两段第二段首轮失败，重试不再调第一段 STT", async () => {
    const state = freshState()
    const t = createPodcastTranscriber(makeDeps(state, { segCount: 2, sttStatusSeq: [200, 429] }))
    await assert.rejects(() => t.ensureDigest(EP), /STT HTTP 429/)
    assert.equal(state.sttCalls, 2)
    const partial = readEpisodeRecord(baseDir, episodeCacheKey(EP.enclosureUrl))
    assert.equal(partial?.transcript, null)
    assert.equal(partial?.segCount, 2)
    assert.equal(partial?.segTexts?.[0], "转写全文内容") // 第一段成果已持久化
    assert.equal(partial?.segTexts?.[1], null)

    // 重试：仅第二段走 STT
    const state2 = freshState()
    const t2 = createPodcastTranscriber(makeDeps(state2, { segCount: 2 }))
    const rec = await t2.ensureDigest(EP)
    assert.equal(state2.sttCalls, 1, "已成段绝不重烧 STT")
    assert.equal(rec.transcript, "转写全文内容\n转写全文内容")
    assert.ok(rec.digestZh)
  })
})

describe("ensureDigest 全新集全链", () => {
  it("下载→segment 转码→转写→提炼→落盘，tmp 清理干净", async () => {
    const state = freshState()
    const t = createPodcastTranscriber(makeDeps(state))
    const rec = await t.ensureDigest(EP)
    assert.equal(state.audioCalls.length, 1)
    assert.equal(state.spawnArgs.length, 1) // segment muxer 单次调用
    assert.ok(state.spawnArgs[0].join(" ").includes(`-f segment -segment_time ${SEGMENT_SEC}`))
    assert.equal(state.sttCalls, 1)
    assert.equal(state.runnerCalls, 1)
    assert.ok(rec.digestZh?.startsWith("• 要点一"))
    assert.ok(rec.transcribedAt)
    assert.ok(rec.digestedAt)
    const onDisk = readEpisodeRecord(baseDir, episodeCacheKey(EP.enclosureUrl))
    assert.equal(onDisk?.digestZh, rec.digestZh)
    const tmpLeft = fs.existsSync(path.join(baseDir, "tmp"))
      ? fs.readdirSync(path.join(baseDir, "tmp"))
      : []
    assert.deepEqual(tmpLeft, [])
  })

  it("长集多段：ffmpeg 按 EOF 产 2 段（feed 时长不参与段数决策），逐段转写拼接", async () => {
    const state = freshState()
    const t = createPodcastTranscriber(makeDeps(state, { segCount: 2 }))
    // 故意「低报」时长（P2-3：段数由 ffmpeg 实际产出决定，不信 feed）
    const rec = await t.ensureDigest({ ...EP, durationSec: 60 })
    assert.equal(state.spawnArgs.length, 1)
    assert.equal(state.sttCalls, 2)
    assert.equal(rec.transcript, "转写全文内容\n转写全文内容")
  })

  it("段大小后验（P2-3 红测）：产出段超 STT 单文件门 → 拒绝上传", async () => {
    const state = freshState()
    const t = createPodcastTranscriber(makeDeps(state, { segBytes: 25 * 1024 * 1024 }))
    await assert.rejects(() => t.ensureDigest(EP), /超 STT 单文件门/)
    assert.equal(state.sttCalls, 0, "超门段绝不上传")
  })
})

describe("取消贯通（德彪 r1 P1-2）", () => {
  it("预 abort 的 signal：零下载零 spawn 零 STT", async () => {
    const state = freshState()
    const t = createPodcastTranscriber(makeDeps(state))
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(() => t.ensureDigest(EP, ac.signal))
    assert.equal(state.audioCalls.length, 0)
    assert.equal(state.spawnArgs.length, 0)
    assert.equal(state.sttCalls, 0)
  })

  it("段间 abort：后续段 STT 不再发出，已成段仍持久化", async () => {
    const state = freshState()
    const ac = new AbortController()
    const deps = makeDeps(state, { segCount: 3 })
    const origStt = deps.sttFetchImpl
    deps.sttFetchImpl = (async (...a: Parameters<typeof fetch>) => {
      const r = await (origStt as typeof fetch)(...a)
      ac.abort() // 第一段 STT 成功后立刻掐
      return r
    }) as typeof fetch
    const t = createPodcastTranscriber(deps)
    await assert.rejects(() => t.ensureDigest(EP, ac.signal))
    assert.equal(state.sttCalls, 1, "abort 后段循环立停")
    const partial = readEpisodeRecord(baseDir, episodeCacheKey(EP.enclosureUrl))
    assert.equal(partial?.segTexts?.[0], "转写全文内容")
  })
})

describe("安全与失败面", () => {
  it("enclosure host 不在白名单：拒下载", async () => {
    const state = freshState()
    const t = createPodcastTranscriber(makeDeps(state))
    await assert.rejects(
      () => t.ensureDigest({ ...EP, enclosureUrl: "https://evil.example.com/a.mp3" }),
      /不在白名单/,
    )
    assert.equal(state.audioCalls.length, 0)
  })

  it("enclosure 非 https / 带 userinfo / 自定义端口：拒下载", async () => {
    const t = createPodcastTranscriber(makeDeps(freshState()))
    await assert.rejects(
      () => t.ensureDigest({ ...EP, enclosureUrl: "http://media.xyzcdn.net/a.mp3" }),
      /非 https/,
    )
    await assert.rejects(
      () => t.ensureDigest({ ...EP, enclosureUrl: "https://u:p@media.xyzcdn.net/a.mp3" }),
      /userinfo/,
    )
    await assert.rejects(
      () => t.ensureDigest({ ...EP, enclosureUrl: "https://media.xyzcdn.net:8443/a.mp3" }),
      /非默认端口/,
    )
  })

  it("redirect 到禁区（德彪 r1 P1-1 红测）：第二跳 fetch 从未发生", async () => {
    const state = freshState()
    const deps = makeDeps(state)
    deps.audioFetchImpl = (async (url: string | URL | Request) => {
      state.audioCalls.push(String(url))
      return audioResponse({ status: 302, location: "https://169.254.169.254/latest/meta-data" })
    }) as unknown as typeof fetch
    const t = createPodcastTranscriber(deps)
    await assert.rejects(() => t.ensureDigest(EP), /不在白名单/)
    assert.equal(state.audioCalls.length, 1, "越界跳的请求绝不发出")
  })

  it("redirect 白名单内正常跟随；降级 http 跳被拒", async () => {
    const state = freshState()
    const deps = makeDeps(state)
    let first = true
    deps.audioFetchImpl = (async (url: string | URL | Request) => {
      state.audioCalls.push(String(url))
      if (first) {
        first = false
        return audioResponse({ status: 302, location: "https://media.xyzcdn.net/real/a.m4a" })
      }
      return audioResponse()
    }) as unknown as typeof fetch
    const rec = await createPodcastTranscriber(deps).ensureDigest(EP)
    assert.equal(state.audioCalls.length, 2)
    assert.ok(rec.digestZh)

    const state2 = freshState()
    const deps2 = makeDeps(state2)
    deps2.audioFetchImpl = (async (url: string | URL | Request) => {
      state2.audioCalls.push(String(url))
      return audioResponse({ status: 302, location: "http://media.xyzcdn.net/a.m4a" })
    }) as unknown as typeof fetch
    // 换 enclosure（前半段已给 EP 写了缓存，同 key 会直接命中不走下载）
    const ep2 = { ...EP, enclosureUrl: "https://media.xyzcdn.net/648b/audio2.m4a" }
    await assert.rejects(() => createPodcastTranscriber(deps2).ensureDigest(ep2), /非 https/)
    assert.equal(state2.audioCalls.length, 1)
  })

  it("redirect 循环超跳数上限：拒绝", async () => {
    const state = freshState()
    const deps = makeDeps(state)
    deps.audioFetchImpl = (async (url: string | URL | Request) => {
      state.audioCalls.push(String(url))
      return audioResponse({ status: 302, location: "https://media.xyzcdn.net/loop/a.m4a" })
    }) as unknown as typeof fetch
    await assert.rejects(() => createPodcastTranscriber(deps).ensureDigest(EP), /redirect 超/)
  })

  it("ffmpeg 未装（ENOENT）：错误信息带安装指引", async () => {
    const t = createPodcastTranscriber(makeDeps(freshState(), { spawnFail: "enoent" }))
    await assert.rejects(() => t.ensureDigest(EP), /ffmpeg 未安装/)
  })

  it("ffmpeg 非零退出：stderr 尾部进错误", async () => {
    const t = createPodcastTranscriber(makeDeps(freshState(), { spawnFail: "exit1" }))
    await assert.rejects(() => t.ensureDigest(EP), /ffmpeg exit 1/)
  })

  it("STT 非 2xx：错误带 status，成品 transcript 不落盘", async () => {
    const state = freshState()
    const t = createPodcastTranscriber(makeDeps(state, { sttStatus: 429 }))
    await assert.rejects(() => t.ensureDigest(EP), /STT HTTP 429/)
    const cached = readEpisodeRecord(baseDir, episodeCacheKey(EP.enclosureUrl))
    assert.ok(!cached?.transcript)
  })

  it("声明 content-length 超 150MB 硬顶：拒收", async () => {
    const state = freshState()
    const deps = makeDeps(state)
    deps.audioFetchImpl = (async () =>
      audioResponse({ declaredBytes: 151 * 1024 * 1024 })) as unknown as typeof fetch
    const t = createPodcastTranscriber(deps)
    await assert.rejects(() => t.ensureDigest(EP), /超上限/)
  })
})

describe("STT provider 通用化（07-11：硅基流动切换）", () => {
  it("自定义 sttBase/sttModel：endpoint 正确拼接、model 随请求发出", async () => {
    const seen: Array<{ url: string; model: string }> = []
    const state = freshState()
    const deps = {
      ...makeDeps(state),
      sttBase: "https://api.siliconflow.cn/v1/",
      sttModel: "FunAudioLLM/SenseVoiceSmall",
      sttFetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const fd = init?.body as FormData
        seen.push({ url: String(url), model: String(fd.get("model")) })
        return sttResponse("转写全文内容")
      }) as unknown as typeof fetch,
    }
    const t = createPodcastTranscriber(deps)
    const rec = await t.ensureDigest(EP)
    assert.equal(seen[0].url, "https://api.siliconflow.cn/v1/audio/transcriptions")
    assert.equal(seen[0].model, "FunAudioLLM/SenseVoiceSmall")
    assert.ok(rec.digestZh)
  })

  it("缺省走 Groq base + whisper-large-v3-turbo", async () => {
    const seen: Array<{ url: string; model: string }> = []
    const state = freshState()
    const deps = {
      ...makeDeps(state),
      sttFetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const fd = init?.body as FormData
        seen.push({ url: String(url), model: String(fd.get("model")) })
        return sttResponse("转写全文内容")
      }) as unknown as typeof fetch,
    }
    await createPodcastTranscriber(deps).ensureDigest(EP)
    assert.equal(seen[0].url, "https://api.groq.com/openai/v1/audio/transcriptions")
    assert.equal(seen[0].model, "whisper-large-v3-turbo")
  })
})

describe("德彪 r2 残余修复红测", () => {
  it("P1：LLM 提炼期间 abort → runner 收到 signal、缓存不写 digest（迟到写防护）", async () => {
    const state = freshState()
    const ac = new AbortController()
    let runnerSawSignal = false
    const deps = {
      ...makeDeps(state),
      runner: {
        runPrompt: async (_p: string, opts?: { signal?: AbortSignal }) => {
          runnerSawSignal = opts?.signal === ac.signal
          ac.abort() // 提炼期间预算掐断——runner 仍带回结果（迟到）
          return { ok: true, text: "• 迟到要点", durationMs: 5 }
        },
      },
    }
    const t = createPodcastTranscriber(deps)
    await assert.rejects(() => t.ensureDigest(EP, ac.signal))
    assert.ok(runnerSawSignal, "signal 必须直通 runner（kill CLI 子进程）")
    const cached = readEpisodeRecord(baseDir, episodeCacheKey(EP.enclosureUrl))
    assert.equal(cached?.digestZh ?? null, null, "abort 后绝不迟到写 digest")
    assert.equal(cached?.transcript, "转写全文内容", "已完成的转写仍保留（下轮只补提炼）")
  })

  it("P3-1：全新多段成功 → 最终 record 持久化本轮 segTexts（非旧 cached）", async () => {
    const state = freshState()
    const t = createPodcastTranscriber(makeDeps(state, { segCount: 2 }))
    await t.ensureDigest(EP)
    const onDisk = readEpisodeRecord(baseDir, episodeCacheKey(EP.enclosureUrl))
    assert.equal(onDisk?.segCount, 2)
    assert.deepEqual(onDisk?.segTexts, ["转写全文内容", "转写全文内容"], "段缓存不得丢失")
  })

  it("P3-1：部分重试成功 → 最终 record 无 null 段（不把旧 null 写回）", async () => {
    // 先造「第一段成、第二段败」的部分缓存
    const state1 = freshState()
    const t1 = createPodcastTranscriber(makeDeps(state1, { segCount: 2, sttStatusSeq: [200, 429] }))
    await assert.rejects(() => t1.ensureDigest(EP))
    // 重试成功
    const state2 = freshState()
    const t2 = createPodcastTranscriber(makeDeps(state2, { segCount: 2 }))
    await t2.ensureDigest(EP)
    const onDisk = readEpisodeRecord(baseDir, episodeCacheKey(EP.enclosureUrl))
    assert.deepEqual(onDisk?.segTexts, ["转写全文内容", "转写全文内容"], "旧 null 不得写回")
    assert.ok(onDisk?.digestZh)
  })

  it("P2：3h 后验收紧——估算 3h10m（低报 60s）→ 拒绝", async () => {
    const state = freshState()
    // 2 段 × 23MB = 46MB → est ≈ 11,500s > 3h+300s（11,100s）；单段 23MB < 24.5MB 段门
    const t = createPodcastTranscriber(makeDeps(state, { segCount: 2, segBytes: 23 * 1024 * 1024 }))
    await assert.rejects(() => t.ensureDigest({ ...EP, durationSec: 60 }), /超 3h 上限/)
    assert.equal(state.sttCalls, 0)
  })
})
