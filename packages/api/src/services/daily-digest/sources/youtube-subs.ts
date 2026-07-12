import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/**
 * #34 YouTube 视频转写——字幕优先路线（07-10 设计拍板）：
 * yt-dlp `--skip-download --write-auto-subs` 拉字幕（YouTube 自动字幕覆盖率 >95%，
 * 零转写成本），喂 summarizer deep-read 当"正文"。音频+Whisper 兜底不做（覆盖率
 * 缺口小、成本高，台账留案）。
 *
 * 依赖姿态：yt-dlp 是可选外部二进制——探测不到（ENOENT）= 整条路静默关闭
 * （fetchSubtitleText 返回 null → deep-read 回落既有 http 抓取 → YouTube SPA 页
 * 抽不出正文 → 保持原摘要），行为与本批合入前完全一致。
 */

/** 字幕端点 429 的退避重试间隔（07-12 实测：清单拿得到、下载轨才 429=代理出口 IP 突发
 *  窗口限流，隔半分钟重试有真实成功率）。看门狗账 deep-read 腿据此推导（scheduler-config.test）：
 *  单视频最坏 = 90s 首次 + 30s 退避 + 90s 重试 = 210s。改这里必重算那笔账。 */
export const SUBTITLE_429_RETRY_DELAY_MS = 30_000
/** 单视频拉字幕默认超时（导出供看门狗账推导） */
export const DEFAULT_SUBTITLE_TIMEOUT_MS = 90_000

export interface YtSubsDeps {
  /** 缺省 PATH 里的 "yt-dlp"（env MULTI_AGENT_DIGEST_YTDLP_PATH 可覆盖） */
  ytDlpPath?: string
  /** ffmpeg 绝对路径（boot 注入 bootEnv.MULTI_AGENT_DIGEST_FFMPEG_PATH）：其目录会前置进
   *  yt-dlp 子进程 PATH——07-12 第六封实测 yt-dlp 探不到 ffmpeg 拉字幕失败（jtw-r2 P2-2：
   *  必须走 boot env 注入契约，不读全局 process.env） */
  ffmpegPath?: string
  /** YouTube 登录 cookies 文件（Netscape 格式；boot 注入 bootEnv.MULTI_AGENT_DIGEST_YT_COOKIES）：
   *  登录配额远宽于匿名（07-12 小孙拍板 D 方案，小号导出）——缺省匿名（fail-open）。
   *  argv 只出现文件路径，内容永不进日志/进程列表 */
  cookiesPath?: string
  /** 大陆访问 YouTube 必走代理（boot 注入 env.proxy） */
  proxyUrl?: string
  /** 429 退避重试间隔覆盖（测试注入；生产恒 SUBTITLE_429_RETRY_DELAY_MS） */
  retry429DelayMs?: number
  /** 字幕临时文件目录（.runtime/daily-digest/tmp） */
  tmpDir: string
  spawnImpl?: typeof spawn
  log?: (m: string) => void
  /** 单视频拉字幕超时，默认 90s（走代理 + YouTube 慢） */
  timeoutMs?: number
}

/** 只喂 YouTube 链接给 yt-dlp（它支持上千站点——纵深防御钉死边界） */
const YT_HOSTS: ReadonlySet<string> = new Set(["www.youtube.com", "youtube.com", "youtu.be"])

export function isYouTubeUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "https:" && YT_HOSTS.has(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * 深读 fetchContent 的 yt 适配器（07-12 德彪 jtw-r1 P2：接线语义必须可测，boot 内联闭包
 * 改回 null 直传时测试要能咬）：yt-* 条目字幕拉不到返回 ""（明确无内容）——summarizer
 * runDeepReads 只在 null 时回落 http，"" 绝不触发对 YouTube 页的抓取（JS 渲染页静态抓
 * 永远只有版权/导航样板=「检讨文」根因），且过不了 200 字喂入闸；非 yt 条目返回 null
 * 走默认 http 路径。boot 与 summarizer 集成测试共用本函数。
 */
export function makeYtDeepReadFetchContent(
  fetchSubtitleText: (videoUrl: string) => Promise<string | null>,
): (item: { sourceId: string; canonicalUrl: string }) => Promise<string | null> {
  return async (item) =>
    item.sourceId.startsWith("yt-")
      ? ((await fetchSubtitleText(item.canonicalUrl)) ?? "")
      : null
}

/**
 * WebVTT → 纯文本：剥头/时间戳/cue 设置/内联 tag（<c>、<00:00:00.000>）；
 * **连续重复行去重**——YouTube 自动字幕是滚动窗口（每行在相邻 cue 重复出现），
 * 不去重的话文本膨胀 ~2x 且全是复读。
 */
export function parseVttToText(vtt: string): string {
  const lines = vtt.split(/\r?\n/)
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^WEBVTT/i.test(line)) continue
    if (/^(Kind|Language):/i.test(line)) continue
    if (/^NOTE\b/.test(line)) continue
    if (line.includes("-->")) continue // 时间戳行（含 cue settings 尾巴）
    if (/^\d+$/.test(line)) continue // cue 序号
    const text = line
      .replace(/<[^>]*>/g, "") // 内联 tag：<c>、<c.colorE5E5E5>、<00:00:01.500>
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim()
    if (!text) continue
    if (out.length > 0 && out[out.length - 1] === text) continue // 滚动重复
    out.push(text)
  }
  return out.join(" ")
}

export interface SubtitleFetcher {
  /** 拉字幕文本；任何失败/无字幕/依赖缺失 → null（fail-open 回落调用方默认路径） */
  fetchSubtitleText(videoUrl: string): Promise<string | null>
}

/** 字幕语言优先级（德彪 r1 P3-1：字典序 en < zh-Hans，.sort()[0] 实际英语优先——显式 rank） */
export function subtitleLangRank(lang: string): number {
  if (lang === "zh-Hans") return 0
  if (lang.startsWith("zh")) return 1
  if (lang.startsWith("en")) return 2
  return 3
}

export function createYtSubsFetcher(deps: YtSubsDeps): SubtitleFetcher {
  const log = deps.log ?? (() => {})
  const spawnImpl = deps.spawnImpl ?? spawn
  const ytDlpPath = deps.ytDlpPath ?? "yt-dlp"
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SUBTITLE_TIMEOUT_MS
  /** ENOENT 记忆化：yt-dlp 未装时首次探明即关闭，之后零 spawn 开销 */
  let unavailable = false

  /** 日志/错误脱敏（德彪 r1 P2-5 + r2 percent-decoded + r3 子串序）：yt-dlp stderr 可能
   * 回显代理地址；WHATWG URL getter 保留 %40/%2F 编码而工具常打印解码形态——raw/decoded
   * 全变体收集去重后**按长度降序**替换（r3 实测：password=foo 先替换会把 username=foobar
   * 打碎成 ***bar 泄漏后缀，长值必须先脱）。 */
  function sanitizeProxy(s: string): string {
    if (!deps.proxyUrl) return s
    const secrets = new Set<string>([deps.proxyUrl])
    try {
      const u = new URL(deps.proxyUrl)
      for (const raw of [u.password, u.username]) {
        if (!raw) continue
        secrets.add(raw)
        try {
          const decoded = decodeURIComponent(raw)
          if (decoded !== raw) secrets.add(decoded)
        } catch {
          /* 非法编码序列：raw 已收 */
        }
      }
    } catch {
      /* 不可解析就只脱原串 */
    }
    let out = s
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join("***")
    }
    return out
  }

  /**
   * cookies 模式安全错误枚举（德彪 hitrate-r1 P1）：只输出分类，绝不透传 stderr 原文。
   * stderrTail 只在内存里做模式匹配——「429」进枚举文案是刻意的（上层重试判定靠它）。
   */
  function classifySubtitleFailure(stderrTail: string, code: number | null): string {
    if (/429|too many requests/i.test(stderrTail)) return "HTTP 429 rate-limited"
    if (/timed? ?out/i.test(stderrTail)) return "network timeout"
    return `yt-dlp failed (exit ${code})`
  }

  function runYtDlp(args: string[]): Promise<{ code: number | null; err?: Error }> {
    return new Promise((resolve) => {
      // 代理经子进程 env 传递（德彪 r1 P2-5：argv 进本机进程列表，代理 URL 可能带
      // user:pass——boot 对同一 URL 的日志都做了脱敏，argv 明文是倒退）
      // ffmpeg 目录注进子进程 PATH（07-12 第六封实测：手动发信 shell 探不到 winget PATH，
      // yt-dlp 连带探不到 ffmpeg 报「Installing ffmpeg is strongly recommended」拉字幕失败；
      // 路径走 deps 注入=boot env 契约，jtw-r2 P2-2）
      const ffmpegDir = deps.ffmpegPath ? path.dirname(deps.ffmpegPath) : null
      const child = spawnImpl(ytDlpPath, args, {
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          ...(ffmpegDir ? { PATH: `${ffmpegDir}${path.delimiter}${process.env.PATH ?? ""}` } : {}),
          ...(deps.proxyUrl ? { HTTPS_PROXY: deps.proxyUrl, HTTP_PROXY: deps.proxyUrl } : {}),
        },
      })
      let stderrTail = ""
      child.stderr?.on("data", (d: unknown) => {
        // 窗口放大到 2000：ERROR 行要完整存活（07-12 教训：300 字符窗里 ffmpeg warning
        // 把真 ERROR 挤出去，「Installing ffmpeg…」被误当败因诊断了两轮）
        stderrTail = (stderrTail + String(d)).slice(-2000)
      })
      const timer = setTimeout(() => {
        child.kill()
        resolve({ code: null, err: new Error("yt-dlp 超时") })
      }, timeoutMs)
      child.on("error", (err: Error) => {
        clearTimeout(timer)
        resolve({ code: null, err })
      })
      child.on("close", (code: number | null) => {
        clearTimeout(timer)
        // 失败信息优先取最后一条 ERROR: 行（yt-dlp 惯例格式）——warning 噪音不再淹没真因；
        // 无 ERROR 行才回落尾部截断。
        // 德彪 hitrate-r1 P1：cookies 模式下 stderr 的内容形态不受我们控制（yt-dlp 读的
        // 导出文件含全站点凭证，错误 dump 可能回显 cookie 值）——原文一律不出进程边界，
        // 归类为安全枚举（枚举保留「429」字样供上层重试判定）。未配 cookies 无凭证暴露面，
        // 保留 ERROR 行的诊断价值（代理地址照常脱敏）。
        const errorLine = stderrTail
          .split(/\r?\n/)
          .reverse()
          .find((l) => l.startsWith("ERROR:"))
        const msg = deps.cookiesPath
          ? classifySubtitleFailure(stderrTail, code)
          : sanitizeProxy(errorLine ?? stderrTail.slice(-200)) || `exit ${code}`
        resolve(code === 0 ? { code } : { code, err: new Error(msg) })
      })
    })
  }

  return {
    async fetchSubtitleText(videoUrl) {
      if (unavailable) return null
      if (!isYouTubeUrl(videoUrl)) return null
      fs.mkdirSync(deps.tmpDir, { recursive: true })
      const stem = `ytsub-${randomBytes(6).toString("hex")}`
      const outTmpl = path.join(deps.tmpDir, `${stem}.%(ext)s`)
      const args = [
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        // JS runtime 钉死 node（07-12：yt-dlp 已宣布无 JS runtime 的 YouTube 提取
        // deprecated「some formats may be missing」——runtime 本身就是 node 进程，PATH 必有）
        "--js-runtimes",
        "node",
        // 登录 cookies（D 方案）：登录配额远宽于匿名 429 阈值；未配则匿名 fail-open
        ...(deps.cookiesPath ? ["--cookies", deps.cookiesPath] : []),
        // 语言收窄成精确两目标（07-11 活体：通配符 zh.*/en.* 会枚举出多条翻译轨、
        // 逐轨请求——代理出口 IP 立刻 429；单轨 +sleep 实测过）
        "--sub-langs",
        "zh-Hans,en",
        // 字幕请求间隔：YouTube 字幕端点对共享代理 IP 限流敏感（429 实测）
        "--sleep-subtitles",
        "3",
        // 德彪 r1 P3-3：host 校验放行频道/playlist 页——禁止批量展开；-- 终止选项解析
        "--no-playlist",
        "--sub-format",
        "vtt",
        "-o",
        outTmpl,
        "--",
        videoUrl,
      ]
      try {
        let { err } = await runYtDlp(args)
        // 429 退避重试一次（07-12 实测：字幕清单拿得到、下载轨才 429=突发窗口限流，
        // 隔半分钟重试有真实成功率）；看门狗账单条最坏 90+30+90=210s 已计入
        if (err && (err as NodeJS.ErrnoException).code !== "ENOENT" && /429/.test(err.message)) {
          const delayMs = deps.retry429DelayMs ?? SUBTITLE_429_RETRY_DELAY_MS
          log(
            `[daily-digest] 字幕端点 429——${Math.round(delayMs / 1000)}s 退避后重试一次：${videoUrl.slice(0, 80)}`,
          )
          await new Promise((r) => setTimeout(r, delayMs))
          ;({ err } = await runYtDlp(args))
        }
        if (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            unavailable = true
            log("[daily-digest] yt-dlp 未安装——YouTube 字幕深读关闭（回落原摘要路径）")
          } else {
            log(`[daily-digest] yt-dlp 拉字幕失败：${String(err.message).slice(0, 160)}`)
          }
          return null
        }
        const vttFile = fs
          .readdirSync(deps.tmpDir)
          .filter((f) => f.startsWith(stem) && f.endsWith(".vtt"))
          // 显式语言优先级（P3-1）：文件名 <stem>.<lang>.vtt，中文轨优先英文轨兜底
          .sort((a, b) => {
            const lang = (f: string) => f.slice(stem.length + 1, -4)
            return subtitleLangRank(lang(a)) - subtitleLangRank(lang(b))
          })[0]
        if (!vttFile) {
          log(`[daily-digest] yt-dlp 成功但无字幕产出（该视频无字幕）：${videoUrl.slice(0, 80)}`)
          return null
        }
        const text = parseVttToText(fs.readFileSync(path.join(deps.tmpDir, vttFile), "utf8"))
        return text.length >= 200 ? text : null
      } catch (err) {
        log(`[daily-digest] YouTube 字幕路线异常：${String(err).slice(0, 160)}`)
        return null
      } finally {
        // stem 前缀全清（yt-dlp 可能落多语言多文件）
        try {
          for (const f of fs.readdirSync(deps.tmpDir)) {
            if (f.startsWith(stem)) fs.unlinkSync(path.join(deps.tmpDir, f))
          }
        } catch {
          /* tmp 清理失败无害 */
        }
      }
    },
  }
}
