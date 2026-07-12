import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  createYtSubsFetcher,
  isYouTubeUrl,
  makeYtDeepReadFetchContent,
  parseVttToText,
  subtitleLangRank,
} from "./youtube-subs"

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytsubs-test-"))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** YouTube 自动字幕 vtt 真实形态缩样：头 + Kind/Language + 时间戳带 cue settings + 内联 timing tag + 滚动重复行 */
const VTT_FIXTURE = [
  "WEBVTT",
  "Kind: captions",
  "Language: en",
  "",
  "00:00:00.000 --> 00:00:02.500 align:start position:0%",
  "so<00:00:00.320><c> today</c><00:00:00.640><c> we're</c><00:00:01.040><c> talking</c>",
  "",
  "00:00:02.500 --> 00:00:04.000 align:start position:0%",
  "so today we're talking",
  "about transformers &amp; attention",
  "",
  "00:00:04.000 --> 00:00:06.000",
  "about transformers &amp; attention",
  "the key insight is scale",
  "",
].join("\n")

describe("parseVttToText", () => {
  it("剥头/时间戳/内联 tag/实体，滚动重复行去重", () => {
    const text = parseVttToText(VTT_FIXTURE)
    assert.equal(
      text,
      "so today we're talking about transformers & attention the key insight is scale",
    )
    assert.ok(!text.includes("-->"))
    assert.ok(!text.includes("<c>"))
    assert.ok(!text.includes("WEBVTT"))
  })

  it("空/纯头 vtt → 空串", () => {
    assert.equal(parseVttToText("WEBVTT\nKind: captions\n"), "")
  })
})

describe("isYouTubeUrl", () => {
  it("只放行 https 的 youtube.com/youtu.be", () => {
    assert.equal(isYouTubeUrl("https://www.youtube.com/watch?v=abc"), true)
    assert.equal(isYouTubeUrl("https://youtu.be/abc"), true)
    assert.equal(isYouTubeUrl("http://www.youtube.com/watch?v=abc"), false)
    assert.equal(isYouTubeUrl("https://evil.example.com/watch?v=abc"), false)
    assert.equal(isYouTubeUrl("not a url"), false)
  })
})

type SpawnBehavior = "write-vtt" | "enoent" | "exit1" | "no-output" | "exit1-429" | "exit1-secret"

interface SpawnState {
  calls: string[][]
  envs: Array<Record<string, string | undefined> | undefined>
  behavior: SpawnBehavior
  /** 逐调用行为序列（429 重试测试用）：非空时按序 shift，耗尽回落 behavior */
  behaviors?: SpawnBehavior[]
  /** 写出的字幕内容（write-vtt 行为用） */
  vttBody?: string
}

function mockSpawn(state: SpawnState): typeof import("node:child_process").spawn {
  return ((_cmd: string, args: string[], opts?: { env?: Record<string, string | undefined> }) => {
    state.calls.push(args)
    state.envs.push(opts?.env)
    const behavior = state.behaviors?.length ? (state.behaviors.shift() as SpawnBehavior) : state.behavior
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void }
    child.stderr = new EventEmitter()
    child.kill = () => {}
    process.nextTick(() => {
      if (behavior === "exit1-429") {
        child.stderr.emit(
          "data",
          "WARNING: some noise\nERROR: Unable to download video subtitles for 'zh-Hans': HTTP Error 429: Too Many Requests\n",
        )
        child.emit("close", 1)
        return
      }
      if (behavior === "enoent") {
        const err = new Error("spawn yt-dlp ENOENT") as NodeJS.ErrnoException
        err.code = "ENOENT"
        child.emit("error", err)
        return
      }
      if (behavior === "exit1") {
        child.stderr.emit("data", "ERROR: This video is unavailable")
        child.emit("close", 1)
        return
      }
      if (behavior === "exit1-secret") {
        // 德彪 hitrate-r1 P1 回归形态：stderr 回显 cookie 值（yt-dlp 错误 dump 面不受控）
        child.stderr.emit(
          "data",
          "WARNING: noise\nERROR: request failed; Cookie: SID=SUPER_SECRET_COOKIE_VALUE; retry later\n",
        )
        child.emit("close", 1)
        return
      }
      if (behavior === "write-vtt") {
        // 真 yt-dlp 按 -o 模板落 <stem>.<lang>.vtt
        const outTmpl = args[args.indexOf("-o") + 1]
        const stem = path.basename(outTmpl).replace(".%(ext)s", "")
        fs.writeFileSync(
          path.join(path.dirname(outTmpl), `${stem}.en.vtt`),
          state.vttBody ?? VTT_FIXTURE,
        )
      }
      child.emit("close", 0)
    })
    return child
  }) as unknown as typeof import("node:child_process").spawn
}

const VIDEO = "https://www.youtube.com/watch?v=abc123"

describe("createYtSubsFetcher", () => {
  it("成功：vtt → 文本（≥200 字），tmp 清理干净，代理参数带上", async () => {
    const longVtt = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${"transformer scale insight ".repeat(20)}\n`
    const state: SpawnState = { calls: [], envs: [], behavior: "write-vtt", vttBody: longVtt }
    const f = createYtSubsFetcher({
      tmpDir,
      proxyUrl: "http://127.0.0.1:7890",
      spawnImpl: mockSpawn(state),
    })
    const text = await f.fetchSubtitleText(VIDEO)
    assert.ok(text && text.length >= 200)
    assert.ok(text.includes("transformer scale insight"))
    const args = state.calls[0]
    // 德彪 r1 P2-5：代理绝不进 argv（进程列表可见），走子进程 env
    assert.ok(!args.includes("--proxy"))
    assert.ok(!args.join(" ").includes("127.0.0.1:7890"))
    assert.equal(state.envs[0]?.HTTPS_PROXY, "http://127.0.0.1:7890")
    assert.ok(args.includes("--skip-download"))
    // 德彪 r1 P3-3：禁 playlist 批量展开 + -- 终止选项解析且 URL 在其后
    assert.ok(args.includes("--no-playlist"))
    assert.equal(args[args.indexOf("--") + 1], VIDEO)
    assert.deepEqual(fs.readdirSync(tmpDir), []) // stem 前缀全清
  })

  it("字幕过短（<200 字）→ null（信息量不足不喂深读）", async () => {
    const state: SpawnState = { calls: [], envs: [], behavior: "write-vtt", vttBody: VTT_FIXTURE }
    const f = createYtSubsFetcher({ tmpDir, spawnImpl: mockSpawn(state) })
    assert.equal(await f.fetchSubtitleText(VIDEO), null)
  })

  it("ffmpegPath 注入 → 子进程 PATH 前置其目录且与 proxy 共存；不注入 → PATH 原样（jtw-r2 P2-2：走 deps 契约不读全局 env）", async () => {
    const state: SpawnState = { calls: [], envs: [], behavior: "no-output" }
    const f = createYtSubsFetcher({
      tmpDir,
      spawnImpl: mockSpawn(state),
      ffmpegPath: path.join("C:", "tools", "ffmpeg", "bin", "ffmpeg.exe"),
      proxyUrl: "http://127.0.0.1:7890",
    })
    await f.fetchSubtitleText(VIDEO)
    const env1 = state.envs[0]
    assert.ok(
      env1?.PATH?.startsWith(`${path.join("C:", "tools", "ffmpeg", "bin")}${path.delimiter}`),
      `ffmpeg 目录必须前置进子进程 PATH（实际: ${env1?.PATH?.slice(0, 60)}）`,
    )
    assert.equal(env1?.HTTPS_PROXY, "http://127.0.0.1:7890", "与 proxy env 共存")

    const state2: SpawnState = { calls: [], envs: [], behavior: "no-output" }
    const f2 = createYtSubsFetcher({ tmpDir, spawnImpl: mockSpawn(state2) })
    await f2.fetchSubtitleText(VIDEO)
    assert.equal(state2.envs[0]?.PATH, process.env.PATH, "不注入时 PATH 不得被改写")
  })

  it("cookies 配置 → argv 带 --cookies 路径；未配 → 不带（07-12 D 方案）；--js-runtimes node 常开", async () => {
    const state: SpawnState = { calls: [], envs: [], behavior: "no-output" }
    const f = createYtSubsFetcher({
      tmpDir,
      spawnImpl: mockSpawn(state),
      cookiesPath: path.join("C:", "secrets", "yt-cookies.txt"),
    })
    await f.fetchSubtitleText(VIDEO)
    const args1 = state.calls[0]
    const ci = args1.indexOf("--cookies")
    assert.ok(ci > -1, "配置 cookies 必须进 argv")
    assert.equal(args1[ci + 1], path.join("C:", "secrets", "yt-cookies.txt"))
    const ji = args1.indexOf("--js-runtimes")
    assert.ok(ji > -1, "JS runtime 必须钉死（无 runtime 的提取已 deprecated）")
    assert.equal(args1[ji + 1], "node")

    const state2: SpawnState = { calls: [], envs: [], behavior: "no-output" }
    const f2 = createYtSubsFetcher({ tmpDir, spawnImpl: mockSpawn(state2) })
    await f2.fetchSubtitleText(VIDEO)
    assert.ok(!state2.calls[0].includes("--cookies"), "未配 cookies 不得出现该参数（匿名 fail-open）")
  })

  it("字幕端点 429 → 退避后重试一次成功；非 429 失败不重试（07-12 命中率批）", async () => {
    const longVtt = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${"retry rescue insight ".repeat(20)}\n`
    const state: SpawnState = {
      calls: [],
      envs: [],
      behavior: "write-vtt",
      behaviors: ["exit1-429", "write-vtt"],
      vttBody: longVtt,
    }
    const logs: string[] = []
    const f = createYtSubsFetcher({
      tmpDir,
      spawnImpl: mockSpawn(state),
      retry429DelayMs: 1,
      log: (m) => logs.push(m),
    })
    const text = await f.fetchSubtitleText(VIDEO)
    assert.ok(text?.includes("retry rescue insight"), "重试第二次成功必须拿到字幕")
    assert.equal(state.calls.length, 2, "429 恰好重试一次")
    assert.ok(logs.some((l) => l.includes("429") && l.includes("退避")), "退避要可观测")

    // 非 429 失败（unavailable 类）不重试
    const state2: SpawnState = { calls: [], envs: [], behavior: "exit1" }
    const f2 = createYtSubsFetcher({ tmpDir, spawnImpl: mockSpawn(state2), retry429DelayMs: 1 })
    assert.equal(await f2.fetchSubtitleText(VIDEO), null)
    assert.equal(state2.calls.length, 1, "非 429 失败不得重试")
  })

  it("stderr 失败信息优先取 ERROR: 行——warning 噪音不再淹没真因（07-12 ffmpeg 烟雾弹教训）", async () => {
    const state: SpawnState = { calls: [], envs: [], behavior: "exit1-429" }
    const logs: string[] = []
    const f = createYtSubsFetcher({
      tmpDir,
      spawnImpl: mockSpawn(state),
      retry429DelayMs: 1,
      log: (m) => logs.push(m),
    })
    await f.fetchSubtitleText(VIDEO)
    const failLog = logs.find((l) => l.includes("拉字幕失败"))
    assert.ok(failLog, "两次 429 后应有失败日志")
    assert.ok(failLog?.includes("HTTP Error 429"), "失败信息必须是 ERROR 行内容")
    assert.ok(!failLog?.includes("WARNING"), "warning 噪音不得进失败信息")
  })

  it("cookies 模式凭证不落日志：stderr 回显 cookie 值 → 只输出安全枚举（德彪 hitrate-r1 P1）", async () => {
    const state: SpawnState = { calls: [], envs: [], behavior: "exit1-secret" }
    const logs: string[] = []
    const f = createYtSubsFetcher({
      tmpDir,
      spawnImpl: mockSpawn(state),
      cookiesPath: path.join("C:", "secrets", "yt-cookies.txt"),
      log: (m) => logs.push(m),
    })
    assert.equal(await f.fetchSubtitleText(VIDEO), null)
    assert.ok(
      logs.every((l) => !l.includes("SUPER_SECRET_COOKIE_VALUE")),
      `cookie 值绝不进日志（实际日志: ${logs.join(" | ")}）`,
    )
    const failLog = logs.find((l) => l.includes("拉字幕失败"))
    assert.ok(failLog?.includes("yt-dlp failed (exit 1)"), "失败信息必须是安全枚举形态")
    assert.ok(!failLog?.includes("ERROR:"), "cookies 模式不得透传 stderr 原文")
  })

  it("cookies 模式 429 枚举兼容重试判定：退避重试照跑、日志无 stderr 原文", async () => {
    const state: SpawnState = {
      calls: [],
      envs: [],
      behavior: "exit1-429",
      behaviors: ["exit1-429", "exit1-429"],
    }
    const logs: string[] = []
    const f = createYtSubsFetcher({
      tmpDir,
      spawnImpl: mockSpawn(state),
      cookiesPath: path.join("C:", "secrets", "yt-cookies.txt"),
      retry429DelayMs: 1,
      log: (m) => logs.push(m),
    })
    assert.equal(await f.fetchSubtitleText(VIDEO), null)
    assert.equal(state.calls.length, 2, "枚举含 429 字样，重试判定必须照常触发")
    const failLog = logs.find((l) => l.includes("拉字幕失败"))
    assert.ok(failLog?.includes("HTTP 429 rate-limited"), "失败信息=429 安全枚举")
    assert.ok(!failLog?.includes("Too Many Requests"), "stderr 原文不得透传")
  })

  it("yt-dlp 未装（ENOENT）→ null 且记忆化：二次调用零 spawn", async () => {
    const state: SpawnState = { calls: [], envs: [], behavior: "enoent" }
    const f = createYtSubsFetcher({ tmpDir, spawnImpl: mockSpawn(state) })
    assert.equal(await f.fetchSubtitleText(VIDEO), null)
    assert.equal(await f.fetchSubtitleText(VIDEO), null)
    assert.equal(state.calls.length, 1, "ENOENT 后不再 spawn")
  })

  it("单视频失败（exit 1）→ null 但不关闭整条路（下条视频仍试）", async () => {
    const state: SpawnState = { calls: [], envs: [], behavior: "exit1" }
    const f = createYtSubsFetcher({ tmpDir, spawnImpl: mockSpawn(state) })
    assert.equal(await f.fetchSubtitleText(VIDEO), null)
    assert.equal(await f.fetchSubtitleText(VIDEO), null)
    assert.equal(state.calls.length, 2, "exit1 不记忆化")
  })

  it("成功但无字幕产出（该视频没字幕）→ null", async () => {
    const state: SpawnState = { calls: [], envs: [], behavior: "no-output" }
    const f = createYtSubsFetcher({ tmpDir, spawnImpl: mockSpawn(state) })
    assert.equal(await f.fetchSubtitleText(VIDEO), null)
  })

  it("非 YouTube URL → null 零 spawn（yt-dlp 千站支持面钉死不外溢）", async () => {
    const state: SpawnState = { calls: [], envs: [], behavior: "write-vtt" }
    const f = createYtSubsFetcher({ tmpDir, spawnImpl: mockSpawn(state) })
    assert.equal(await f.fetchSubtitleText("https://evil.example.com/watch"), null)
    assert.equal(state.calls.length, 0)
  })
})

describe("语言优先级与脱敏（德彪 r1 P3-1/P2-5 红测）", () => {
  it("en 与 zh-Hans 双字幕并存：选 zh-Hans（字典序会错选 en）", async () => {
    const state: SpawnState = { calls: [], envs: [], behavior: "write-vtt" }
    const spawnBoth = ((
      _cmd: string,
      args: string[],
      opts?: { env?: Record<string, string | undefined> },
    ) => {
      state.calls.push(args)
      state.envs.push(opts?.env)
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void }
      child.stderr = new EventEmitter()
      child.kill = () => {}
      process.nextTick(() => {
        const outTmpl = args[args.indexOf("-o") + 1]
        const stem = path.basename(outTmpl).replace(".%(ext)s", "")
        const dir = path.dirname(outTmpl)
        const long = (tag: string) =>
          `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${`${tag} subtitle content `.repeat(20)}\n`
        fs.writeFileSync(path.join(dir, `${stem}.en.vtt`), long("english"))
        fs.writeFileSync(path.join(dir, `${stem}.zh-Hans.vtt`), long("中文"))
        child.emit("close", 0)
      })
      return child
    }) as unknown as typeof import("node:child_process").spawn
    const f = createYtSubsFetcher({ tmpDir, spawnImpl: spawnBoth })
    const text = await f.fetchSubtitleText(VIDEO)
    assert.ok(text?.includes("中文"), "必须选中文轨")
    assert.ok(!text?.includes("english"))
  })

  it("subtitleLangRank：zh-Hans < zh-Hant < en < 其他", () => {
    assert.ok(subtitleLangRank("zh-Hans") < subtitleLangRank("zh-Hant"))
    assert.ok(subtitleLangRank("zh-Hant") < subtitleLangRank("en"))
    assert.ok(subtitleLangRank("en") < subtitleLangRank("ja"))
  })

  it("stderr 回显代理地址：错误日志脱敏（user:pass 绝不入日志）", async () => {
    const logs: string[] = []
    const proxyUrl = "http://user:secret@127.0.0.1:7890"
    const spawnEcho = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void }
      child.stderr = new EventEmitter()
      child.kill = () => {}
      process.nextTick(() => {
        child.stderr.emit("data", `ERROR: cannot connect via ${proxyUrl}`)
        child.emit("close", 1)
      })
      return child
    }) as unknown as typeof import("node:child_process").spawn
    const f = createYtSubsFetcher({
      tmpDir,
      proxyUrl,
      spawnImpl: spawnEcho,
      log: (m) => logs.push(m),
    })
    assert.equal(await f.fetchSubtitleText(VIDEO), null)
    const joined = logs.join("\n")
    assert.ok(!joined.includes("secret"), "密码绝不入日志")
    assert.ok(!joined.includes(proxyUrl))
  })
})

describe("德彪 r2：percent-decoded 凭证脱敏", () => {
  it("URL 带 %40/%2F 编码凭证、stderr 打解码形态 → 两态都不入日志", async () => {
    const logs: string[] = []
    const proxyUrl = "http://user:p%40ss%2Fword@127.0.0.1:7890"
    const spawnEcho = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void }
      child.stderr = new EventEmitter()
      child.kill = () => {}
      process.nextTick(() => {
        // yt-dlp 常打印解码后的形态
        child.stderr.emit("data", "ERROR: proxy auth failed for p@ss/word (raw p%40ss%2Fword)")
        child.emit("close", 1)
      })
      return child
    }) as unknown as typeof import("node:child_process").spawn
    const f = createYtSubsFetcher({
      tmpDir,
      proxyUrl,
      spawnImpl: spawnEcho,
      log: (m) => logs.push(m),
    })
    assert.equal(await f.fetchSubtitleText(VIDEO), null)
    const joined = logs.join("\n")
    assert.ok(!joined.includes("p@ss/word"), "解码形态不入日志")
    assert.ok(!joined.includes("p%40ss%2Fword"), "编码形态不入日志")
  })
})

describe("德彪 r3：互为子串凭证脱敏顺序", () => {
  it("password=foo 是 username=foobar 的子串：长值先脱，不泄后缀", async () => {
    const logs: string[] = []
    const proxyUrl = "http://foobar:foo@127.0.0.1:7890"
    const spawnEcho = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void }
      child.stderr = new EventEmitter()
      child.kill = () => {}
      process.nextTick(() => {
        child.stderr.emit("data", "ERROR: auth failed for username=foobar password=foo")
        child.emit("close", 1)
      })
      return child
    }) as unknown as typeof import("node:child_process").spawn
    const f = createYtSubsFetcher({ tmpDir, proxyUrl, spawnImpl: spawnEcho, log: (m) => logs.push(m) })
    assert.equal(await f.fetchSubtitleText(VIDEO), null)
    const joined = logs.join("\n")
    assert.ok(!joined.includes("foobar"), "长凭证整体脱除")
    assert.ok(!joined.includes("***bar"), "短值先替换的打碎泄漏（r3 实测反例）不得出现")
  })
})

describe("makeYtDeepReadFetchContent（07-12 德彪 jtw-r1 P2：接线语义单点锁定）", () => {
  it("yt 条目字幕拉不到 → 空串（明确无内容，深读绝不 http 回落）；拉到 → 原文透传", async () => {
    const noSub = makeYtDeepReadFetchContent(async () => null)
    assert.equal(
      await noSub({ sourceId: "yt-anthropic", canonicalUrl: "https://www.youtube.com/watch?v=a" }),
      "",
    )
    const withSub = makeYtDeepReadFetchContent(async () => "字幕全文")
    assert.equal(
      await withSub({ sourceId: "yt-anthropic", canonicalUrl: "https://www.youtube.com/watch?v=a" }),
      "字幕全文",
    )
  })

  it("非 yt 条目 → null（走深读默认 http 路径，简报型源正文抓取不受影响）", async () => {
    const fetcher = makeYtDeepReadFetchContent(async () => {
      throw new Error("非 yt 条目不许触发字幕拉取")
    })
    assert.equal(
      await fetcher({ sourceId: "smol-ai", canonicalUrl: "https://news.smol.ai/i/1" }),
      null,
    )
  })
})
