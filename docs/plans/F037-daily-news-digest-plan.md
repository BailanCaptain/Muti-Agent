# DailyBrief 日报邮件推送系统 Implementation Plan (Phase 1)

**Feature:** F037 — `docs/features/F037-daily-news-digest.md`
**Goal:** 每日 07:30 自动生成五板块中文 HTML 日报邮件发到小孙邮箱（速览摘要→板块分节→源健康页脚），周一附 GitHub 周榜；at-least-once 有界重试幂等，单源失败隔离，SafeHttpClient 出站合同。
**Acceptance Criteria:** AC1 定时+补发+幂等（D10/D11）｜AC2 版式速览→板块→页脚｜AC3 AI 板块（推理/训练加权）｜AC4 热点｜AC5 篮球+电竞｜AC6 股票大盘要闻（非交易日缩减）｜AC7 GitHub 周榜（周一）｜AC8 单源隔离+连续 3 天失败 R-201+健康持久化｜AC9 归档｜AC10 SafeHttpClient+收件人白名单 .env+外发账本｜AC11 LLM 全挂发清单版｜AC12 邮件渲染验收（内联 CSS/≤600px/无脚本无远程图/快照测试）
**Architecture:** 新目录 `packages/api/src/services/daily-digest/`。reconcile(businessDate) 幂等单入口 ×3 触发（07:30 主 cron / startup / 每小时安全网），由 SchedulerRuntime 装配。管道：sources（表驱动 fetcher + SafeHttpClient）→ orchestrator（并发+隔离+去重+健康记账）→ summarizer（LLM 结构化 JSON，只引用 item id）→ renderer（数据直出 HTML，LLM 不产 URL/HTML）→ EmailSender（nodemailer QQ SMTP）→ archive + ledger。
**Tech Stack:** node:test（仓规）、nodemailer、fast-xml-parser（新依赖 ×2）；LLM 走 `createDynamicWikiCompileRunner`/`createOpusRunner` + `createRunnerWithFallback`；调度走 `DEFAULT_SCHEDULER_CONFIG` + `scheduler-bootstrap.ts`。

**Non-goals（Phase 1 不做）：** 自建 RSSHub（AC13）、个股自选（AC14）、X 直采（AC15）、前端 UI（纯后端 job，产出是邮件+归档文件）。

**测试纪律：** 单测一律不打真网 —— fetcher 全部注入 fake SafeHttpClient + fixture（真实抓回的 XML/JSON 样本落 `__fixtures__/`）；真网连通性用手动 smoke 脚本验（Task 15），活体 SMTP 只在小孙填 .env 后 smoke 一次（AC12）。

---

## 终态 Schema（所有任务围绕它构建，只扩展不重写）

```ts
// packages/api/src/services/daily-digest/types.ts
export type DigestCategory = "ai" | "hot" | "basketball" | "esports" | "stocks" | "github"

export interface NormalizedItem {
  id: string             // sha1(sourceId + "\n" + canonicalUrl) 前 16 hex
  dedupeKey: string      // canonicalUrl 归一（去 utm_*/fragment/尾斜杠，host 小写）
  category: DigestCategory
  sourceId: string
  title: string
  canonicalUrl: string
  publishedAt: string | null   // ISO8601
  rawSnippet: string           // 纯文本 ≤2000 chars
}

export interface SourceFetchResult {
  sourceId: string
  status: "ok" | "failed" | "timeout"
  items: NormalizedItem[]
  errors: string[]
  attempts: number
  fetchedAt: string
  durationMs: number
}

export interface DigestSource {
  sourceId: string
  category: DigestCategory
  /** fetcher 内不抛业务错误；解析失败返回 [] 并由 orchestrator 记 failed */
  fetch(ctx: SourceFetchContext): Promise<NormalizedItem[]>
}
export interface SourceFetchContext { http: SafeHttpClient; signal: AbortSignal; now: () => Date }

// SafeHttpClient（safe-http-client.ts）—— 合同见 feature doc「设计合同 v2」
export interface SafeHttpClient {
  /** 非 2xx/超限/校验失败均 throw SafeHttpError{kind} */
  fetchText(url: string, opts?: { headers?: Record<string, string>; maxBytes?: number; timeoutMs?: number }): Promise<string>
}
export type SafeHttpErrorKind =
  | "scheme" | "userinfo" | "port" | "host_not_allowed" | "ip_blocked"
  | "redirect_limit" | "redirect_invalid" | "too_large" | "timeout" | "http_status" | "network"

// 幂等 ledger（digest-ledger.ts）：attempted 计数 + sent 唯一终态；failed 只是 attempt 明细非终态（德彪 r2）
export interface DigestLedger {
  read(businessDate: string): { attempts: number; sentAt: string | null }
  recordAttempt(businessDate: string, note: string): void       // 原子（tmp+rename append）
  recordSent(businessDate: string, meta: { messageId: string; to: string }): void
}

// 源健康（source-health.ts）：持久化 sourceId/date/status/errorKind，连续失败判定重启不丢
export interface SourceHealthStore {
  record(date: string, results: SourceFetchResult[]): void
  consecutiveFailures(sourceId: string, endDate: string): number
}

// summarizer 输出（LLM 只引用 id，绝不产 URL/HTML —— 注入护栏）
export interface DigestSummary {
  overview: string[]                                   // 今日速览 5-8 条中文
  sections: Array<{ category: DigestCategory; picks: Array<{ itemId: string; summaryZh: string }> }>
  degraded: boolean                                    // true = LLM 挂了走清单版（AC11）
}
```

**目录终态：**
```
packages/api/src/services/daily-digest/
  types.ts safe-http-client.ts digest-ledger.ts source-health.ts
  feed-parsers.ts            # RSS/Atom/JSON 解析纯函数
  sources/registry.ts        # 表驱动源配置（唯一加源入口）+ 自定义 fetcher
  sources/github-trending.ts # trending scrape + 新贵榜 + 加权
  orchestrator.ts            # 并发/隔离/去重/健康
  summarizer.ts renderer.ts email-sender.ts archive.ts
  daily-digest-job.ts        # reconcile(businessDate) 单入口
  __fixtures__/              # 真实抓回样本
packages/api/src/services/scheduler/scheduler-config.ts   # +2 cron 行
packages/api/src/runtime/scheduler-bootstrap.ts           # 装配 + startup job
```

---

## Task 1: worktree + 依赖

1. `worktree` skill 建 `feat/F037-daily-digest`；worktree 内 `pnpm add --filter @multi-agent/api nodemailer fast-xml-parser && pnpm add -D --filter @multi-agent/api @types/nodemailer`
2. `pnpm --filter @multi-agent/api typecheck` 过 → commit `chore(F037): deps nodemailer + fast-xml-parser [黄仁勋]`
3. ⚠️ 记忆教训：merge 后主仓必须 `pnpm install` + 真起 build（feedback_pnpm_install_on_main_after_dep_merge）。

## Task 2: types + id/dedupe 纯函数

- Test: `makeItemId` 稳定性/`makeDedupeKey` 去 utm/fragment/尾斜杠/host 小写/`truncateSnippet` 2000 上限（先写失败测试→实现→绿→commit，下同，不再重复列 TDD 五步）。
- Files: `types.ts` + `item-identity.ts` + `item-identity.test.ts`。

## Task 3: SafeHttpClient（AC10 核心，测试矩阵=合同逐条）

- Files: `safe-http-client.ts` + test。构造注入：`allowlist: string[]`（完整 host；后缀白名单单独 `allowedSuffixes` 且默认空）、`resolveDns`（测试注入 fake resolver）、`fetchImpl`（测试注入 fake fetch）。
- 实现要点：`redirect: "manual"`；逐跳：parse URL → scheme ∈ {http,https} → 无 userinfo → 端口 ∈ {80,443} → host 在白名单 → resolveDns 全部 A/AAAA 过 `isBlockedIp`（IANA 精确段：0/8,10/8,100.64/10,127/8,169.254/16,172.16/12,192.168/16,224/4,240/4,::1,fc00/7,fe80/10,::ffff:0:0/96 映射段解包后重判）→ fetch；3xx 则取 Location 重走全套校验，≤3 跳；响应流式累读，超 `maxBytes`（默认 2MB）abort 抛 too_large；`AbortSignal.timeout`（默认 20s）。
- 测试矩阵（每条合同≥1 用例）：file:// 拒 ｜ `https://u:p@host` 拒 ｜ :8080 拒 ｜ 白名单外 host 拒 ｜ DNS 返回 127.0.0.1/10.x/169.254.x/fe80::/::ffff:10.0.0.1 全拒 ｜ redirect 到白名单外/私网 IP 拒 ｜ 4 跳拒 ｜ body 超限拒 ｜ 正常 200 过 ｜ 非 2xx 抛 http_status。

## Task 4: DigestLedger（D10）

- 存储：`.runtime/daily-digest/ledger/YYYY-MM-DD.json`（`{attempts:[{at,note}], sent:{at,messageId,to}|null}`），写入走 tmp 文件 + `fs.renameSync` 原子替换。
- 测试：attempt 递增 ｜ sent 后 read.sentAt 非空 ｜ 损坏 JSON → 视为 attempts=0 但 stderr 告警（kill -9 容错，参考 backfill-docs 范式）｜ 重复 recordSent 幂等。

## Task 5: SourceHealthStore（AC8）

- 存储：`.runtime/daily-digest/health/YYYY-MM-DD.json`（`{[sourceId]:{status,errorKind}}`）。
- 测试：record 覆盖写 ｜ consecutiveFailures 连续 3 天 failed=3、中间一天 ok 归零、缺文件视为 ok（不误报）。

## Task 6: feed-parsers 纯函数

- `parseRssOrAtom(xml, sourceId, category) → NormalizedItem[]`（fast-xml-parser；容忍 RSS2.0/Atom；无效 pubDate → null，虎扑 Invalid Date 教训）；`stripHtml`；`parseJsonPath` 小工具。
- Fixtures：实抓样本存 `__fixtures__/`（espn.rss.xml、smolai.rss.xml、zhihu.hotlist.json、hn.algolia.json、hf.dailypapers.json、baidu.board.json、toutiao.board.json、trending.weekly.html 等）。
- 测试：每种 fixture 解析出条目、字段齐全、rawSnippet 无 HTML 标签。

## Task 7: 表驱动源注册（AC3/4/5/6 主体）

- `sources/registry.ts`：`RSS_SOURCES: Array<{sourceId, category, url, headers?}>` + `JSON_SOURCES: Array<{sourceId, category, url, map:(json)=>NormalizedItem[]}>`，一个通用 `makeRssSource`/`makeJsonSource` 工厂。**源清单照抄 discussion 文档已验证 URL**：
  - ai: smol.ai全文 / openai / deepmind / mistral / anthropic桥 / meta桥 / vllm / sglang-releases.atom / hf-blog；JSON: hf-daily-papers（date 参数取昨日）/ hn-algolia（search_by_date, points>100, query=LLM OR AI, 24h 窗）
  - hot: JSON 知乎/百度/头条 + RSS bbc-zhongwen
  - basketball: RSS espn-nba / yahoo-nba + hupu-nba（RSSHub 实例 fallback 链 rssforever→ktachibana，靠 registry 里同 sourceId 多 URL 依序试）
  - esports: RSS dotesports(关键词过滤 lol|dota|cs|valorant|esport) / hltv / hupu-gg / 5eplay（RSSHub 链同上）
  - stocks: JSON sina-7x24（zhibo feed）+ RSS yahoo-finance（^GSPC,^IXIC,NVDA,TSLA 头条）/ cnbc-business；`isCnTradingDay(date)`（周末=false，Phase 1 不做节假日表——YAGNI，页脚注明）非交易日只保留美股+要闻
- 白名单常量 `OUTBOUND_ALLOWLIST` 从 registry 自动推导（所有源 URL 的 host 去重）+ 显式追加 redirect 常见目标（如 github.com）。
- 测试：registry 无重复 sourceId ｜ 每源 URL host ∈ allowlist ｜ makeRssSource 用 fake http 返回 fixture → items 正确 ｜ fallback 链第一个 URL 挂第二个接上。

## Task 8: GitHub 周榜（AC7）

- `sources/github-trending.ts`：`parseTrendingHtml(html)`（正则/cheerio-free 手解 `<article>` 块：repo、desc、stars-this-week 数字）→ 每 repo 走 REST `/repos/{o}/{r}` 取 topics（有 `MULTI_AGENT_DIGEST_GITHUB_PAT` 才做，无 PAT 跳过加权仅出榜单）→ `aiWeight(topics∩{mcp,model-context-protocol,claude,llm,ai-agent,skills} + desc 关键词)` 排序 → Search API `topic:mcp created:>7d sort=stars` 新贵子榜。
- `isMonday(businessDate, tz)` 决定是否出现在日报。
- 测试：fixture HTML 解析出周增数 ｜ 加权排序 ｜ 无 PAT 降级路径 ｜ 周一才产出。

## Task 9: orchestrator（AC8 隔离 + 去重）

- `runAllSources(sources, ctx) → SourceFetchResult[]`：每源独立 `Promise` + per-source timeout（25s）+ try/catch → status；全部 settle 后跨源 `dedupeKey` 去重（保留 publishedAt 新者）；调 SourceHealthStore.record；返回 results + `freshItems`。
- 测试：一源抛错其余正常 ｜ 超时源 status=timeout ｜ 跨源重复条目只留一条 ｜ health 被记录。

## Task 10: summarizer（AC3 加权 + AC11 降级 + 注入护栏）

- 仿 `production-compile-llm-client.ts`：system prompt 固定；user message = 结构化 data block（JSON items：id/title/snippet/source/category，**不含 URL**）；要求输出 JSON `DigestSummary`（overview 5-8 条；每板块 picks≤8，ai 板块按「推理优化/训练」优先）；parse fail-closed：JSON 非法/引用不存在的 itemId/正文含 http(s):// → 丢弃该字段或整体降级。
- 降级链：dynamic runner → opus → haiku；全挂 → `degraded:true`，picks=每板块按 publishedAt 取前 6（清单版）。
- 测试：fake runner 返回合法 JSON → 通过 ｜ 引用幽灵 id → 该 pick 被剔除 ｜ 输出带 URL → 剔除 ｜ runner 全抛 → degraded 清单版 ｜ prompt-injection 标题样本（"ignore previous instructions…"）不改变输出结构（P2-2 回归）。

## Task 11: renderer（AC2 + AC12）

- `renderDigest(summary, itemsById, health, opts) → { html, markdown, subject }`：subject `📰 DailyBrief YYYY-MM-DD`；HTML 全内联样式 + 单列 table ≤600px + 板块色条 + 每条「标题(链接)—摘要—来源」+ 页脚健康表；**链接只从 `itemsById[pick.itemId].canonicalUrl` 取**（护栏落地）；文本过 `escapeHtml`。markdown 版供归档。
- 测试（AC12 快照式断言而非全文快照，避免脆）：无 `<script`、无 `http` 开头的 `<img src`、含 `max-width:600px`、每 pick 的 href 与 canonicalUrl 严格相等、degraded 版含「今日无 AI 摘要（降级清单版）」字样、health 失败源出现在页脚。

## Task 12: EmailSender + 外发账本（AC10）

- `email-sender.ts`：`EmailSender` 接口 + `createQqSmtpSender(env)`（nodemailer smtp.qq.com:465 secure）+ `createMockSender(dir)`（写 .eml 到归档目录，开发/测试用）。收件人：`MULTI_AGENT_DIGEST_TO` 单值即白名单，send 前 assert 收件人===白名单值（fail-closed）。外发账本：`.runtime/daily-digest/outbound-ledger.jsonl` append `{at,to,subject,sections:{cat:n},messageId}`。
- 测试：mock transport 断言 mail options（from/to/subject/html）｜ 收件人不匹配白名单 → 抛 ｜ 账本行写入 ｜ env 缺失 → createQqSmtpSender 返回 null（上层降 mock + R-201 提示未配置）。

## Task 13: daily-digest-job（AC1/AC9，D10/D11 落地）

- `daily-digest-job.ts`：
```ts
async reconcile(now: Date): Promise<JobOutcome> {
  const businessDate = formatDate(now, TZ)
  if (!isPastSendTime(now)) return { status: "skipped_not_due" }
  const st = ledger.read(businessDate)
  if (st.sentAt) return { status: "skipped_already_sent" }
  if (st.attempts >= 2) { alerts.push(R201_MANUAL); return { status: "skipped_needs_manual" } }
  ledger.recordAttempt(businessDate, st.attempts ? "retry_after_unknown(可能重复)" : "first")
  const { results, freshItems } = await runAllSources(...)
  const summary = await summarize(...)
  const rendered = renderDigest(...)
  archive.write(businessDate, rendered)                    // AC9：先归档后发送
  const sent = await sender.send(rendered)
  ledger.recordSent(businessDate, sent)
  healthAlerts(results)                                    // 连续 3 天 → R-201
  return { status: "ok", degraded: summary.degraded }
}
```
- 测试：sent 已存在不重发 ｜ attempts=1 无 sent → 补发一次且 note 含"可能重复" ｜ attempts=2 → 转人工不发 ｜ 发送成功写 sent ｜ 归档文件存在 ｜ 健康告警触发。

## Task 14: 调度接线（AC1 ×3 触发）

- `scheduler-config.ts` `DEFAULT_SCHEDULER_CONFIG.scheduled` +2 行：`daily-digest`（`30 7 * * *`，timeout 600s，window 30min）、`daily-digest-reconcile`（`10 * * * *` 安全网，timeout 600s）；bootstrap 装配两 cron + 一个 `StartupJobRegistration`，三者同调 `reconcile(new Date())`；依赖注入走 `SchedulerBootOptions`（范本 `scheduler-bootstrap.ts:497-515`）。
- 测试：仿 `scheduler-bootstrap.test.ts` 断言两 cron + startup 注册且 name 正确；reconcile 幂等性已在 Task 13 覆盖（同入口多触发点安全）。

## Task 15: smoke 脚本 + quality-gate

1. `scripts/digest-smoke.mjs`：真网跑 runAllSources（只读）+ mock sender → 输出 `.runtime/daily-digest/smoke/` 下 HTML 预览 + 各源健康表；手动跑，不进 CI。
2. 逐源核对 smoke 结果，死源在 registry 注释禁用（诚实标注，不留假绿）。
3. `pnpm typecheck && pnpm test` 全绿 → quality-gate skill → 愿景对照（小孙原话逐条）。
4. 活体件（需小孙 .env）：真发一封到 Gmail → 手机/网页看渲染 → 标「非垃圾」。**未配 .env 不阻塞 review**：AC12 活体项标 BLOCKED-on-小孙。
5. requesting-review → @范德彪 code review（安全底座类，对照 feedback_security_feature_review_depth 清单自查一遍再发）。

---

## Task 顺序依赖

2→3→(4,5,6 并行)→7→(8,9 并行)→10→11→12→13→14→15。每 Task 独立 commit（phase 标签 `feat(F037-P1-T{n})`），worktree 内推进，全 AC 完成+验收前不合 dev（feedback_feature_completion_before_merge）。
