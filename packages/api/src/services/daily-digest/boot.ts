import path from "node:path"
import { ProxyAgent } from "undici"
import { createClaudeModelRunner } from "../../runtime/haiku-runner"
import { createRunnerWithFallback } from "../../runtime/runner-with-fallback"
import { loadRuntimeConfig } from "../../runtime/runtime-config"
import { type DigestRunOverrides, createDailyDigestJob } from "./daily-digest-job"
import { createFileDigestLedger } from "./digest-ledger"
import { type DigestSettings, resolveEffectiveDigestSettings } from "./digest-settings"
import {
  createAllowlistedSender,
  createMockSender,
  createQqSmtpSender,
  resolveDigestEnv,
} from "./email-sender"
import { createSafeHttpClient } from "../../net/safe-http-client"
import { createFileSourceHealthStore } from "./source-health"
import { makeDiggAiSource } from "./sources/digg-ai"
import {
  makeGithubDailySource,
  makeGithubMonthlySource,
  makeGithubNewcomersSource,
  makeGithubWeeklySource,
} from "./sources/github-trending"
import { PODCAST_FEEDS, makePodcastSource } from "./sources/podcast"
import { makeRedditAiSource } from "./sources/reddit-shreddit"
import {
  buildAllSources,
  deriveDeepReadSourceIds,
  deriveOutboundAllowlist,
  deriveYouTubeSourceIds,
} from "./sources/registry"
import {
  createRsshubXProvider,
  createTwitterApiIoProvider,
  makeXSource,
} from "./sources/x-provider"
import { makeXiaohongshuSource } from "./sources/xiaohongshu"
import { createYtSubsFetcher, makeYtDeepReadFetchContent } from "./sources/youtube-subs"
import { createDigestSummarizer } from "./summarizer"

/**
 * T14 组装层：env → 全链真实依赖 → reconcile 单入口。
 * 凭证缺失时降级 mock sender（写 .eml 到归档目录，不外发）——开发/未配置期不阻塞（AC1 说明 + R-201 提示）。
 */

export interface DailyDigestBootOptions {
  env?: NodeJS.ProcessEnv
  rootDir?: string
  log?: (msg: string) => void
  pushAlert?: (msg: string) => void
  /** 设置段读取口（测试注入）；缺省读 runtime-config JSON 的 dailyDigest 段（每轮现读，热生效） */
  loadSettings?: () => DigestSettings | undefined
}

export interface DailyDigestRuntime {
  reconcile: ReturnType<typeof createDailyDigestJob>["reconcile"]
  senderKind: string
}

/**
 * 日报启用门（scheduler 与 server routes 共用一份逻辑，禁双写）：SMTP 凭证齐全
 * （.env 配置即开启意图）+ **任一来源有收件人**（.env 种子或设置页已存清单——德彪
 * batchB-r1 P1：只看 .env 会把「SMTP 在 .env、收件人在设置页」判死）；或
 * MULTI_AGENT_DIGEST_ENABLED=1（mock 外发试跑）；=0 强制关。
 * 默认关 → 测试/CI/未配置环境绝不打真网。收件人在进程运行中才首次配上的场景
 * 需要重启建 runtime（设置页 enabled=false 时有提示）。
 */
export function isDigestEnabled(
  env: NodeJS.ProcessEnv = process.env,
  loadSettings: () => DigestSettings | undefined = () => loadRuntimeConfig().dailyDigest,
): boolean {
  const cfg = resolveDigestEnv(env)
  const flag = env.MULTI_AGENT_DIGEST_ENABLED
  if (flag === "1") return true
  if (flag === "0") return false
  if (!cfg.smtpUser || !cfg.smtpPass) return false
  const hasRecipients = Boolean(cfg.to) || (loadSettings()?.recipients?.length ?? 0) > 0
  return hasRecipients
}

/**
 * 出站代理 fetchImpl（大陆网络：HF/mistral/raw.githubusercontent 直连不通，curl 靠 HTTPS_PROXY 通）。
 * 安全注记（德彪审阅点）：走代理时目标最终解析发生在代理侧，本地 IANA IP 预检对代理路径退化为
 * 「拦显式私网 URL」；host 白名单仍全量生效。代理地址只能来自用户环境（Iron Law §3）。
 */
export function createDigestFetchImpl(
  proxyUrl: string | undefined,
  log: (m: string) => void,
): typeof fetch | undefined {
  if (!proxyUrl) return undefined
  // 德彪 P1r1-P2 + r2：任何日志分支都只打预脱敏 origin —— 代理 URL 可能带 user:pass
  //（HTTPS_PROXY 常见格式），malformed URL 走 catch 时同样禁止原串入日志
  let safeOrigin = "(origin unparsable)"
  try {
    safeOrigin = new URL(proxyUrl).origin
  } catch {
    /* keep placeholder */
  }
  try {
    const dispatcher = new ProxyAgent(proxyUrl)
    log(`[daily-digest] 出站走代理 ${safeOrigin}`)
    return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      fetch(input, { ...init, dispatcher } as RequestInit)) as typeof fetch
  } catch (err) {
    log(`[daily-digest] 代理配置无效，忽略（${(err as Error)?.name ?? "Error"}）：${safeOrigin}`)
    return undefined
  }
}

export function bootDailyDigest(opts: DailyDigestBootOptions = {}): DailyDigestRuntime {
  const bootEnv = opts.env ?? process.env
  const env = resolveDigestEnv(bootEnv)
  const log = opts.log ?? (() => {})
  const pushAlert = opts.pushAlert ?? log
  const baseDir = path.join(opts.rootDir ?? process.cwd(), ".runtime", "daily-digest")
  // 设置段读取口：每轮 reconcile 现读（改设置/点补发即生效）；损坏文件由 loadRuntimeConfig
  // 容错为空 → 全回落 .env 种子
  const loadSettings = opts.loadSettings ?? (() => loadRuntimeConfig().dailyDigest)

  // ---- 静态基建（env-only，Iron Law §3 人工件；设置页碰不到这些）----
  // X 路线：按量 API key 优先，其次自建 RSSHub cookie 路线；账号清单是内容偏好（可设置页改）
  const xApiKey = bootEnv.MULTI_AGENT_DIGEST_X_API_KEY
  const xMode: "api" | "rsshub" | null = xApiKey ? "api" : env.rsshubBase ? "rsshub" : null
  // #31 小红书 sidecar：base 是网络边界锚（env-only）；关键词是内容偏好（可设置页改）
  const xhsBase = bootEnv.MULTI_AGENT_DIGEST_XHS_MCP_BASE || undefined
  // #33 播客转写（07-10；07-11 STT provider 通用化——小孙 Groq 注册被地区拦，切硅基流动）：
  // STT_API_KEY 是启用门（env-only，Iron Law §3 人工件）；BASE/MODEL 缺省 Groq，
  // 硅基流动配 https://api.siliconflow.cn/v1 + FunAudioLLM/SenseVoiceSmall。
  // ffmpeg 缺省 PATH 探测，装在别处用 FFMPEG_PATH 指路
  const sttKey = bootEnv.MULTI_AGENT_DIGEST_STT_API_KEY || undefined
  const sttBaseRaw = bootEnv.MULTI_AGENT_DIGEST_STT_BASE || undefined
  // 德彪 r1 P3-2：自定义 base 必须 https（凭证随 Bearer 头出站，明文 http 直接拒）
  const sttBase = sttBaseRaw && /^https:\/\//i.test(sttBaseRaw) ? sttBaseRaw : undefined
  if (sttBaseRaw && !sttBase)
    log("[daily-digest] MULTI_AGENT_DIGEST_STT_BASE 非 https，忽略（回落默认 Groq）")
  const sttModel = bootEnv.MULTI_AGENT_DIGEST_STT_MODEL || undefined
  // transport 与 base 解耦（P3-2）：默认「自定义 base=国内平替走直连、默认 Groq 走代理」；
  // STT_PROXY=1 强制代理（海外自定义 base 场景）、=0 强制直连
  const sttProxyFlag = bootEnv.MULTI_AGENT_DIGEST_STT_PROXY
  const sttUseProxy = sttProxyFlag === "1" ? true : sttProxyFlag === "0" ? false : !sttBase
  const ffmpegPath = bootEnv.MULTI_AGENT_DIGEST_FFMPEG_PATH || undefined

  // AC13 自建 RSSHub / 小红书 sidecar（常为私网/自定端口）走 trustedBaseUrls 信任锚：
  // 仅 .env 人工配置可进，逐跳精确 origin 匹配。锚随 base 配置即挂（关键词后配也不用重启）
  const allowedHosts = deriveOutboundAllowlist()
  if (xMode === "api") allowedHosts.push("api.twitterapi.io")
  const clientBase = {
    allowedHosts,
    trustedBaseUrls: [...(env.rsshubBase ? [env.rsshubBase] : []), ...(xhsBase ? [xhsBase] : [])],
  }
  const proxyFetch = createDigestFetchImpl(env.proxy, log)
  const http = createSafeHttpClient({ ...clientBase, fetchImpl: proxyFetch })
  // def.direct 源用直连（ESPN/HLTV 对代理出口 IP 反爬）；无代理时两者等价
  const httpDirect = proxyFetch ? createSafeHttpClient(clientBase) : undefined

  // #34 YouTube 字幕深读：yt-dlp 可选外部依赖——未装则首次探明（ENOENT）后整条静默
  // 关闭，行为与不接完全一致。boot 级建一次（unavailable 记忆化跨轮生效，不重复探）
  const ytSubs = createYtSubsFetcher({
    ytDlpPath: bootEnv.MULTI_AGENT_DIGEST_YTDLP_PATH || undefined,
    // jtw-r2 P2-2：ffmpeg 走同一 bootEnv 注入契约（播客 STT 链同款变量），不读全局 process.env
    ffmpegPath: bootEnv.MULTI_AGENT_DIGEST_FFMPEG_PATH || undefined,
    // D 方案（07-12 小孙拍板）：YouTube 登录 cookies 提字幕配额；未配=匿名 fail-open
    cookiesPath: bootEnv.MULTI_AGENT_DIGEST_YT_COOKIES || undefined,
    proxyUrl: env.proxy,
    tmpDir: path.join(baseDir, "tmp"),
    log,
  })

  // sender 种别**每轮判**（德彪 batchB-r1 P1：boot 定死会让「启动时无收件人、
  // 设置页后配」永远走 mock 不真发）——凭证是 env-only，收件人每轮跟设置走：
  // 凭证齐 + 本轮有收件人 → 真 SMTP；否则 mock 落盘不外发。transport 每轮新建
  // 是廉价操作（nodemailer 懒连接，send 时才拨号）。
  const smtpCreds = Boolean(env.smtpUser && env.smtpPass)
  const mockOutboxDir = path.join(baseDir, "mock-outbox")
  function buildSender(recipientCount: number) {
    return smtpCreds && recipientCount > 0
      ? createQqSmtpSender({ user: env.smtpUser as string, pass: env.smtpPass as string })
      : createMockSender(mockOutboxDir)
  }
  const bootEffective = resolveEffectiveDigestSettings(bootEnv, loadSettings())
  if (!smtpCreds || bootEffective.recipients.length === 0) {
    log(
      "[daily-digest] SMTP 凭证/收件人未配齐（MULTI_AGENT_DIGEST_SMTP_USER/PASS/TO 或设置页收件人），当前降级 mock sender：日报只落盘不外发（配齐后下一轮自动切真 SMTP）",
    )
  }

  /**
   * 设置页动态件（07-05 §5）：每轮 reconcile 现读 dailyDigest 设置段重建 —— 模型/收件人/
   * X 账号/小红书关键词/逐源开关/发送时间/邮件密度全部热生效。构建的都是无状态闭包，成本可忽略。
   * 注意保持静默（安全网每小时进来一次，enable 类日志只在 boot 打一次）。
   */
  function buildRunOverrides(): DigestRunOverrides {
    const eff = resolveEffectiveDigestSettings(bootEnv, loadSettings())
    const disabled = new Set(eff.disabledSources)

    const runner = createRunnerWithFallback({
      primary: createClaudeModelRunner(eff.primaryModel),
      fallback: createClaudeModelRunner(eff.fallbackModel),
      // 日报场景：primary 任何失败都值得降级试一次（业务错也一样，宁降不缺）
      shouldFallback: (err) => err !== undefined,
    })
    // 质量层 3：简报型源（smol-ai 类）被选中后二次深读正文（同 http 全套白名单/大小/超时约束）；
    // #34：yt-* 条目被选中后深读走字幕路线（fetchContent 覆盖，null 回落 http 默认路径）
    const summarizer = createDigestSummarizer({
      runner,
      log,
      deepRead: {
        http,
        sourceIds: [...deriveDeepReadSourceIds(), ...deriveYouTubeSourceIds()],
        // yt 字幕适配（07-12「检讨文」修2 + 德彪 jtw-r1 P2 接线可测化）：拉不到返回 ""
        // 绝不回落 http 抓 YouTube 样板页——语义在 makeYtDeepReadFetchContent 单点锁定
        fetchContent: makeYtDeepReadFetchContent((url) => ytSubs.fetchSubtitleText(url)),
      },
    })

    // 多收件人（AC10）：清单为空回落 mock 目标哨兵 + sender 同步判种别（本轮无收件人
    // 必然 mock —— 哨兵地址绝不会进真 SMTP，德彪 batchB-r1 P1 组合修法）
    const recipients = eff.recipients.length > 0 ? eff.recipients : ["digest@mock.local"]
    const rawSender = buildSender(eff.recipients.length)

    const extraSources = [
      ...(xMode && eff.xHandles.length > 0
        ? [
            makeXSource({
              provider:
                xMode === "api"
                  ? createTwitterApiIoProvider({ apiKey: xApiKey as string, log })
                  : createRsshubXProvider({ rsshubBase: env.rsshubBase as string, log }),
              handles: eff.xHandles,
            }),
          ]
        : []),
      ...(xhsBase && eff.xhsKeywords.length > 0
        ? [makeXiaohongshuSource({ mcpBase: xhsBase, keywords: eff.xhsKeywords })]
        : []),
      // #33 播客速递：feed 走 http（RSSHub 白名单/信任锚已覆盖）；音频下载直连
      //（xyzcdn 国内 CDN）；提炼共用 summarizer 的 runner 降级链。
      // STT transport 由 sttUseProxy 决定（默认自定义 base 直连/Groq 代理，STT_PROXY 可覆盖）
      ...(sttKey
        ? [
            makePodcastSource({
              sttApiKey: sttKey,
              sttBase,
              sttModel,
              sttFetchImpl: sttUseProxy ? proxyFetch : undefined,
              rsshubBase: env.rsshubBase,
              runner,
              baseDir,
              ffmpegPath,
              log,
            }),
          ]
        : []),
    ]

    return {
      sources: [
        ...buildAllSources({ rsshubBase: env.rsshubBase }),
        // #22/#23（主表 v2.1）：独立 fetcher 模块（多 URL 遍历/RSC 提取，不适合 registry 表驱动）
        makeRedditAiSource(),
        makeDiggAiSource(),
        ...extraSources,
      ].filter((s) => !disabled.has(s.sourceId)),
      githubSources: [
        makeGithubWeeklySource({ pat: env.githubPat }),
        makeGithubNewcomersSource(),
      ].filter((s) => !disabled.has(s.sourceId)),
      githubMonthlySources: [makeGithubMonthlySource({ pat: env.githubPat })].filter(
        (s) => !disabled.has(s.sourceId),
      ),
      githubDailySources: [makeGithubDailySource({ pat: env.githubPat })].filter(
        (s) => !disabled.has(s.sourceId),
      ),
      summarize: (items, businessDate) => summarizer.summarize(items, businessDate),
      // 中文化补全（07-06）：github desc + 速览标题批翻（同 runner 降级链；失败英文直出）
      translateExtras: (input) => summarizer.translateExtras(input),
      sender: createAllowlistedSender(rawSender, recipients),
      recipient: recipients.join(", "),
      sendTime: eff.sendTime,
      // 网页版链接（07-05 分栏改版）：未配置不出链接（邮件在外网收，localhost 链接只对本机有意义）
      webBaseUrl: bootEnv.MULTI_AGENT_DIGEST_WEB_BASE || undefined,
      restOverviewRows: eff.restOverviewRows,
    }
  }

  const initial = buildRunOverrides()
  if (xMode && bootEffective.xHandles.length > 0) {
    log(
      `[daily-digest] X 一手动态启用（${xMode === "api" ? "twitterapi-io 按量" : "自建 RSSHub cookie 路线"}，${bootEffective.xHandles.length} 账号）`,
    )
  }
  if (xhsBase && bootEffective.xhsKeywords.length > 0) {
    log(
      `[daily-digest] 小红书启用（xiaohongshu-mcp sidecar，${bootEffective.xhsKeywords.length} 关键词）`,
    )
  }
  if (sttKey) {
    log(
      `[daily-digest] 播客速递启用（小宇宙 ${PODCAST_FEEDS.length} 播客 → STT 转写 ${sttBase ? "硅基流动路线" : "Groq 路线"}，有新集才成节）`,
    )
  }

  const job = createDailyDigestJob({
    ledger: createFileDigestLedger(baseDir),
    health: createFileSourceHealthStore(baseDir),
    // 静态 deps 用 boot 时刻的动态件快照兜底（runtimeSettings 缺省语义），真相在每轮 overrides
    sources: initial.sources as NonNullable<DigestRunOverrides["sources"]>,
    githubSources: initial.githubSources,
    githubMonthlySources: initial.githubMonthlySources,
    githubDailySources: initial.githubDailySources,
    webBaseUrl: initial.webBaseUrl,
    sendTime: initial.sendTime,
    http,
    httpDirect,
    summarize: initial.summarize as NonNullable<DigestRunOverrides["summarize"]>,
    translateExtras: initial.translateExtras,
    sender: initial.sender as NonNullable<DigestRunOverrides["sender"]>,
    recipient: initial.recipient as string,
    baseDir,
    pushAlert,
    log,
    runtimeSettings: buildRunOverrides,
  })

  // senderKind = boot 时刻快照（仅日志/展示用；真种别每轮由 buildSender 现判）
  return {
    reconcile: job.reconcile,
    senderKind: buildSender(bootEffective.recipients.length).kind,
  }
}
