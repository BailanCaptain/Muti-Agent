---
id: F037
title: 日报邮件推送系统（DailyBrief）
status: done
owner: 黄仁勋
created: 2026-07-03
completed: 2026-07-12
---

# F037 — 日报邮件推送系统（DailyBrief）

## Why

小孙原话（2026-07-02）：

> 我想要做一个日报推送系统，每天把相关信息发送到我的邮箱，发送的格式先是摘要，然后是各类精准来源。覆盖面：1、体育板块：篮球新闻，电竞新闻；2、AI板块：当前AI的最新新闻，重点在大模型推理的相关工作和新闻上，特别是受关注的优化点，还有训练等等（参考 https://news.smol.ai/ ）；3、热点新闻；4、股票市场相关的新闻（参考 https://github.com/ZhuLinsen/daily_stock_analysis ）；5、每周github热榜（根据星级增长速度，和一周内星星总数，和AI相关的skill、MCP最好）。必须参考：信息源=各大AI公司官网、各大AI公司以及相关从业者的X（一手动态）；https://github.com/mvanhorn/last30days-skill ；github.com/Panniantong/Agent-Reach 。你也可以自己发挥下想象力。

现状痛点：信息散在 X / 官网 blog / 虎扑 / 热榜 / GitHub trending 各处，每天手动刷，无法稳定覆盖「推理优化/训练」这类垂直信号。

## What

每天定时（默认 07:30 Asia/Shanghai）自动生成一封**中文 HTML 日报邮件**发到小孙邮箱：

> **范围收敛（2026-07-03 小孙拍板）**：「让我们纯粹一点 删除篮球、股市、电竞相关的」——板块纯化为 **AI / X 一手动态 / 热点 / GitHub 周榜**（D15）。原 AC5/AC6/AC14 随之移除，下文保留原文划线存档。

- **版式**：顶部「今日速览」（LLM 跨板块总摘要）→ 板块分节（AI / X 一手动态 / 热点），每条 = 标题 + 一句话中文摘要 + 来源名 + 原文链接
- **周一加餐**：「GitHub 周榜」板块（按权威周增 star 排名 + AI/MCP/skill 主题加权 + 新贵子榜）
- **页脚**：当日源健康状态（失败源明示，不静默）
- 每日 markdown + html 本地归档可回看；机器当时不在线则启动后补发（按日幂等）

## 架构设计（草案，待 Design Gate）

```
SchedulerRuntime cron job（daily-digest, 07:30 + startup catch-up）
  → fetchers（每源独立隔离：超时/重试/fallback 链，出站域名白名单 + SSRF 基线）
  → normalize（统一 NormalizedItem：title/url/source/publishedAt/raw）
  → LLM 筛选+摘要（复用 runner 抽象 + 降级链；推理/训练关键词加权；Markdown 中间格式）
  → 渲染（Markdown → 内联 CSS HTML，table 布局 ≤600px）
  → EmailSender（接口化：QQ SMTP 首选 / Resend 备选；收件人白名单 .env）
  → 归档 .runtime/daily-digest/YYYY-MM-DD/ + 外发账本 + sent-marker（幂等）
```

**复用**（仓内摸底 2026-07-02，详见 discussion 文档）：调度 `SchedulerRuntime`（croner + leader + trace + R-201）、LLM `createDynamicWikiCompileRunner`/`createOpusRunner` + `createRunnerWithFallback`（结构化 client 仿 `production-compile-llm-client.ts`）、digest 分层仿 `weekly-draft-digest.ts`。

**从零写**：出站 HTTP 抓取层（无现成 fetch 范式/SSRF 模块）、EmailSender（nodemailer）、轻量外发边界（F029 仅 spec 零代码，只作设计参考）。

**方法论借鉴**：last30days-skill（免 key 基线+付费增强分层、engagement 加权、per-author cap）、Agent-Reach（多后端 fallback 链 + 活体探测）、daily_stock_analysis（Markdown 中间格式、非交易日跳过、通知降噪）。

### 设计合同 v2（吸收范德彪 r1 设计审：3 P1 + 5 P2）

**SafeHttpClient 出站安全合同（P1-1）**：仅 http/https 且优先 https；白名单=**完整 host 枚举**为主，仅对自有/明确可控域允许受控后缀；禁 userinfo；非常规端口默认拒；每次请求前解析全部 A/AAAA 并按 IANA special-use **精确段**拒绝 loopback/private/link-local/multicast/reserved/IPv4-mapped IPv6（防 DNS rebinding）；**关闭自动 redirect**，设跳数上限且每跳重做 URL/host/DNS/IP 全套校验（防 redirect 逃逸）；响应体流式读取 + 解压后大小上限 + 超时 + abort（防 body bomb）。实施时附测试矩阵：每条合同至少一个用例。

**发送幂等状态机（P1-2 → D10）**：外部 SMTP 无法 exactly-once，拍 **at-least-once + 有界重试**：业务日期 ledger（原子创建/rename）= attempted 计数 + sent 唯一终态（失败只记在 attempt 明细里，**failed 不是终态**——防实现时误当终态造成静默缺报，德彪 r2 术语统一）；发送前 durable 写 attempted，SMTP 成功后写 sent commit；恢复时见 attempted 无 sent（结果未知）→ 补发一次并记 R-201 提示可能重复；attempted≥2 仍无 sent → 停止自动补发，推 R-201 转人工。理由：日报场景「偶收重复」优于「静默缺报」。

**catch-up = reconcile 单入口（P1-3 → D11）**：幂等函数 `reconcile(businessDate)` =「ledger 无 sent 且 now ≥ 发送时间 → 生成+发送」，三个触发点共用同一入口：① 07:30 主 cron ② 进程 startup job ③ **每小时安全网 cron** —— 第三点专门覆盖「follower takeover 成 leader 后不会补跑 startup jobs」的缺口（`scheduler-runtime.ts:223` startup 仅进程启动时跑、`:340` leader guard；takeover 只启 event-driven jobs）。

**Fetcher 合同（P2-1）**：每源返回 `SourceFetchResult { sourceId, status, items, errors, attempts, fetchedAt, durationMs }`，fetcher 内不抛业务错误，orchestrator 统一并发/timeout/fallback/health 计数；`NormalizedItem` 含 `id/dedupeKey/category/sourceId/canonicalUrl/publishedAt/title/rawSnippet`（跨源去重+引用校验）。源健康**持久化**（P2-5）：与 daily ledger 同处存 `sourceId/date/status/errorKind`，连续失败判定重启不丢。

**LLM 轻量注入护栏（P2-2，不上 V14 全套）**：外部内容以结构化 data block 喂入；LLM 输出必须引用输入 item id；正文链接只允许来自 normalized URL 集合；Markdown/HTML 渲染前 sanitize；回归测试含 prompt-injection 式标题样本。

## Acceptance Criteria

> 勾选依据（2026-07-10 收口）：范德彪 12 轮 code review 全 GO（台账=discussions [F037-sources-v2-expansion.md](../discussions/F037-sources-v2-expansion.md) §7）+ 5 天真发账本（07-04/05/06/07/10，`.runtime/daily-digest/outbound-ledger.jsonl`）+ digest 专项测试全绿；合并前 acceptance-guardian 零上下文复核为最后一道门。

### Phase 1 — MVP：管道骨架 + 五板块基础版（零部署依赖源）

- [x] AC1: 每日 07:30（Asia/Shanghai）自动生成并发送日报到配置收件箱；进程当时不在线 → 启动后补发；按日幂等 = at-least-once 有界重试（已确认 sent 的绝不重发；发送结果未知最多补发 1 次并记 R-201；attempted≥2 转人工，见 D10/D11）。机制由 reconcile 三入口 + scheduler 14d 极宽看门狗（1209600s，严格高于 Claude 6h/Codex 12h、播客 96h 及 B032 Claude 故障降级后的保守全链最坏 778350s）关系测试与 5 天全链真发覆盖；首个 07:30 live cron 于合并重启 runtime 后进入观察
- [x] AC2: 邮件版式 = 「今日速览」总摘要 → 板块分节（每条：标题+一句话中文摘要+来源名+原文链接）→ 页脚源健康状态（终态=D17 Bento 版式：导览卡+锚点直达+其余速览行区+刊头体检行）
- [x] AC3: AI 板块：smol.ai 全文 RSS + 官方 blog（OpenAI/DeepMind/Mistral + Anthropic/Meta 社区桥）+ HF Daily Papers API + vLLM blog/SGLang releases + HN 高分 AI 帖（终态超集=40 路主表 §0）；“推理”仅指大模型推理/部署/服务，置于 AI 首位但不独占，推理与非推理两侧均有合格内容时稳定精选各至少一条，真实无合格推理可为空，GPU 融资不得归入推理；mail/web/archive/shown 统一消费预算裁剪后的终态 publication
- [x] AC4: 热点板块：知乎热榜 + 百度热搜 + 头条热榜（直连 JSON）+ BBC 中文 RSS
- ~~AC5: 体育板块（篮球+电竞）~~ **已移除（D15，小孙 2026-07-03 拍板纯化）**——曾完整交付并 review 通过，ESPN/HLTV 反爬教训（简单 UA+直连优先+transport 级 fallback）沉淀在 D12 与 git 历史
- ~~AC6: 股票板块~~ **已移除（D15）**——A 股快讯/美股 RSS/非交易日逻辑一并下线
- [x] AC7: GitHub 板块四榜常驻：scrape trending 日/周/月三时窗（权威增星数）+ Search API 全量 7 天新仓候选；四榜统一以结构化证据判定 `yes/no/unknown`，仅 `yes` 准入，再严格按 `windowStars → totalStars → repo` 排序；邮件端 caps 保持 6/6/4/6，同一期同仓按增长榜 → 周榜 → 新秀榜 → 月榜归属；周/月不跨日抑制，增长/新秀只显示 NEW、连续 X 日或重新上榜而不隐藏；总名“开源榜单”、四组原名、HTML/CSS 与排版不变
- [x] AC8: 可靠性：单源失败隔离（独立超时/try-catch）不影响整报；同源连续 3 天失败推 R-201 告警；源健康计数持久化（重启不丢连续失败判定）；07-06 纠偏=keepIf 全滤「健康空」≠ 失败（`26eba5d`）
- [x] AC9: 归档：每日 markdown + html 落 `.runtime/daily-digest/YYYY-MM-DD/`（终态超集：+summary.json 结构化归档 + items.jsonl 全量证据底料（F029 语料）+ shown.json 已见账本）
- [x] AC10: 安全边界：出站走 SafeHttpClient 合同（完整 host 白名单 + IANA 精确段 + 逐跳 redirect 校验 + 流式大小上限，见「设计合同 v2」，Iron Law §4 对齐）；收件人白名单统一 `.env`（多收件人逐地址 fail-closed）；SMTP 凭证 .env 人工填、代码只读（Iron Law §3）；每次外发落账本（时间/收件人/各板块条数）
- [x] AC11: LLM 失败治理：runner/解析/编辑覆盖失败最多尝试 4 次；全败返回 `null`，job 宁缺勿发、告警且不落 sent，下一整点重试（旧归档清单版仍只读兼容；尾部截断 repairTruncatedJson 不豁免护栏；shown 只记录最终 publication）
- [x] AC12: 邮件渲染验收：HTML 内联 CSS、table 布局 ≤600px、无脚本/无远程图片依赖、链接可点击；本地 HTML/mail-parser 快照测试；上线前 QQ→Gmail 活体 smoke 一次（2026-07-04 PASS，Gmail 实收 degraded=false），mock sender 单测不被活体项阻塞

### Phase 2 — 增强（Phase 1 验收后按需拍）

- [x] AC13: 境内自部署 RSSHub：fallback 链 自建→rssforever→ktachibana（2026-07-04 小孙 Docker 起 `diygod/rsshub` 实例 `localhost:1200`，trustedBaseUrls 信任锚 + 前插链首）；自建实例配小号 cookie 后解锁 Twitter 路由（与 AC15 cookie 路线共用一套部署）
- ~~AC14: 个股自选分析~~ **已移除（D15）**——watchlist 模块（腾讯→新浪多源行情）曾完整交付，随板块纯化删除
- [x] AC15: X 一手动态直采，双路供应商抽象（D16，小孙 2026-07-03 拍 cookie 路线）：**主路=自建 RSSHub `/twitter/user/:handle`（小号 TWITTER_AUTH_TOKEN cookie，免费，封号风险专用小号隔离 + 逐账号限速 4-7s 抖动）**；备路=TwitterAPI.io 按量（配 `_X_API_KEY` 时优先）。终态 35 验活账号（17 机构含 claudeai/claudeDevs + 18 从业者，主表 §5），公司/从业者结构分栏

### Post-completion hardening — B032 证据化编辑判定

- [x] AC16: 审核与摘要彻底分离：`EditorialDecider` 先冻结每个送审 ID 的 publish/reject/abstain；`DigestComposer` 只接收 final publish 原文快照与冻结 facets，不能看到或引用 rejected/abstain 内容。
- [x] AC17: 正常模式下 AI/community/podcast 由两个不同 Claude target 独立审核，争议只交固定 `gpt-5.6-sol/high`；全部 Claude target 均为结构化 runner 失败时必须可进入明确标记的 `degraded_same_target`，由固定 Codex 做 clean-room A/B、分歧才 C。模型/slot provenance 必须如实落档；三票仍无共识则摘除该条并告警，不能因 Claude 不可用阻断其余非空日报，也不能伪称“无推理进展”。
- [x] AC18: 每票携带 1-3 条有界原文 evidence 与 reviewer target；代码验证同 ID/同字段 provenance，并从类型化 basis 派生准入、内容类型与拒绝原因。evidence 不冒充语义正确性证明，confidence 不单独决定准入。
- [x] AC19: `FINANCE/HELP/COMPLAINT/GOSSIP` 与 community substantive 语义正则不再拥有送审前或 publication 后的改判权；Sakana、CUDA、vLLM、推荐模型正例与求助/抱怨/八卦/纯赞叹反例全部穿过终态生产链。
- [x] AC20: 外层归档与 `DigestPublicationV2` 继续 schema v2；邮件格局、原有文案、推理突出但不独占、开源榜单四组、GitHub 排序/跨日状态、单腿 timeout 与 14d watchdog 值均不变。

### Production launch hardening — B033 首封正式日报

- [x] AC21: 新生产 Composer 在获批输入不少于 5 条时输出 5–8 条独立“今日速览”，不得重复引用同一事件凑数；引用必须属于终态 publication。邮件字节裁剪后再次校验，不合格则不发送、不写 sent，交由整点安全网重试。
- [x] AC22: 12 个 YouTube RSS 源的 transport 与可恢复 HTTP 状态统一消费一枚 retry token；`www` 主 feed 最多两次，仍失败时只走一次 `m.youtube.com` 官方备用 feed，总请求最多三次。所有 source HTTP 自动绑定 source 总预算 AbortSignal；单路幂等 GET 可 opt-in，POST、403 等永久错误与普通多路 fallback 不被全局放大。
- [x] AC23: 2026-07-15 07:30 定义为首封正式日报与跨日去重 epoch；此前试发 shown 文件保留但不参与过滤，07-15 成功发布项从 07-16 起成为去重基线。邮件格局、原有文案、“开源榜单”及四组榜单不变。

### Production resilience hardening — B043 共享代理瞬断

- [x] AC24: 43 个 source 由 group-aware 保序就绪调度器执行，默认最多 6 个 source 同时活跃；blocked group 留在 pending、不占全局槽。共享同一上游的 source 可声明组内并发上限和最小启动间隔，同 key 声明在启动前按最小并发/最大间隔聚合，12 个 YouTube feed 固定串行且相隔 1.5 秒。全局及组内排队时间均不计入单源 45 秒/自定义预算。所有 `ctx.http/httpDirect` 请求即使调用点漏传 signal，也必须被 source AbortController 真正取消；两者指向同一底层 client 时复用 wrapper，不破坏 fallback 身份去重。
- [x] AC25: 单路 registry RSS/JSON 与 GitHub 四源显式启用 transport 恢复；整个 source 的所有 GET、`http/httpDirect` 共享且最多消费一次 retry token。`network/timeout` 可恢复，YouTube 额外允许既有状态并使用 3 秒退避，但只有 `www` 主路可消费 token；其主路两次仍失败或 parser-zero 后，`m` 官方备用路都只请求一次。POST、永久错误、普通多 URL/direct fallback、多账号、多 feed 源不逐请求放大。最终完整 shadow 为 43/43、无 SOURCE ALERT、非降级成稿且正式状态哈希不变，已满足精确单收件人重发前置条件。

## Dependencies

- 邮件通道凭证（QQ SMTP，D3 已拍）：小孙人工操作 —— QQ 邮箱网页版 → 设置 → 账号 → 开启「IMAP/SMTP 服务」（短信验证）→ 取 16 位授权码，然后 `.env` 加三行（Iron Law §3，代码只读）：
  - `MULTI_AGENT_DIGEST_SMTP_USER`=QQ 邮箱地址
  - `MULTI_AGENT_DIGEST_SMTP_PASS`=16 位授权码
  - `MULTI_AGENT_DIGEST_TO`=收件箱（bailan.captain@gmail.com）
  - host/port 代码默认 `smtp.qq.com:465`（非敏感不进 .env）。**Phase 1 活体发信前置阻塞项**（开发/测试用 mock sender 不阻塞）
- GitHub PAT（免费，推荐：Search API 10/min → 30/min）
- 无阻塞性 Feature 依赖；Related: F029（外发边界设计参考，其代码未落地不可依赖）

### 完整 env 清单（实现终态，全部 Iron Law §3 人工配置、代码只读）

| 变量 | 必需性 | 作用 |
|------|--------|------|
| `MULTI_AGENT_DIGEST_SMTP_USER` / `_SMTP_PASS` / `_TO` | 活体发信必需 | QQ 邮箱 + 16 位授权码 + 收件箱；三者齐 = 功能启用（D13） |
| `MULTI_AGENT_DIGEST_ENABLED` | 可选 | `1`=无凭证也启用（mock 落盘不外发）；`0`=强制关 |
| `MULTI_AGENT_DIGEST_PROXY` | 推荐（大陆网络） | 出站代理；缺省回退标准 `HTTPS_PROXY`/`HTTP_PROXY`（HF/mistral/anthropic 桥等 7 源直连不通，2026-07-03 实测） |
| `MULTI_AGENT_DIGEST_GITHUB_PAT` | 可选 | GitHub 周榜 topics 加权 + Search 限额提升 |
| `MULTI_AGENT_DIGEST_RSSHUB_BASE` | 可选（AC13/AC15） | 自建 RSSHub base（如 `http://localhost:1200`），信任锚放行 + 前插 fallback 链首；实例配 `TWITTER_AUTH_TOKEN`（小号 cookie）后即 X cookie 路线数据源 |
| `MULTI_AGENT_DIGEST_X_HANDLES` | 可选（AC15） | 关注账号逗号分隔（如 `@sama,karpathy`）；与 `_RSSHUB_BASE`（cookie 路线）或 `_X_API_KEY`（按量路线）任一搭配即启用 X 板块 |
| `MULTI_AGENT_DIGEST_X_API_KEY` | 可选（AC15 备路，花钱项） | TwitterAPI.io key；配置时优先于 cookie 路线 |
| `MULTI_AGENT_DIGEST_STT_API_KEY` | 可选（#33 播客速递启用门） | STT 转写 key；缺省=播客源不注册日报无感。07-11 实配硅基流动（Groq 注册被地区拦） |
| `MULTI_AGENT_DIGEST_STT_BASE` / `_STT_MODEL` | 可选（#33） | OpenAI-compatible base+模型；缺省 Groq `openai/v1`+`whisper-large-v3-turbo`；硅基流动=`api.siliconflow.cn/v1`+`FunAudioLLM/SenseVoiceSmall`（免费档，官方定价页 07-11 核）。配自定义 BASE 走直连、默认 Groq 走代理 |
| `MULTI_AGENT_DIGEST_FFMPEG_PATH` | 可选（#33） | ffmpeg 绝对路径；缺省 PATH 探测（07-11 winget 装 8.1.2，用户 PATH 已挂） |
| `MULTI_AGENT_DIGEST_YTDLP_PATH` | 可选（#34） | yt-dlp 路径；缺省 PATH 探测。未装=YouTube 字幕深读整条静默关闭（行为同未接线），装了自动激活 |

## Design Decisions

| # | 决策 | 选项 | 结论 | 原因 |
|---|------|------|------|------|
| D1 | 运行宿主 | api 进程 SchedulerRuntime / 独立进程 / GitHub Actions | SchedulerRuntime | 复用 leader/幂等/trace/告警；startup catch-up 解决机器不在线 |
| D2 | 中间格式 | Markdown → HTML | Markdown 中间格式 | daily_stock_analysis 先例；渲染/发送解耦 |
| D3 | 邮件通道 | QQ SMTP / Resend / Gmail SMTP | **QQ SMTP（小孙拍 2026-07-03）**；EmailSender 仍接口化，Resend 留作 Phase 2 备通道 | 国内直连零网络问题；Gmail SMTP 大陆被墙排除 |
| D4 | X 一手源 | 白嫖 smol.ai recap / 按量付费直采 | Phase 1 白嫖 smol.ai（544 账号 X recap 全文 RSS） | 官方 API 无免费档（~$45/月）；三方灰色；Phase 2 再拍 |
| D5 | RSSHub | Phase 1 自建 / 公共实例试探 / 不用 | Phase 1 公共实例尽力（fallback 链），Phase 2 境内自建 | rsshub.app 已废；降低 MVP 部署面 |
| D6 | 发送时间 | — | 默认 07:30 Asia/Shanghai，config 可改 | 上班前可读 |
| D7 | 日报语言 | — | 全中文（英文源 LLM 译摘），原文链接保留 | 阅读效率 |
| D8 | 股票范围 | 大盘+市场新闻 / 含个股自选 | **Phase 1 只做大盘+市场要闻（小孙拍 2026-07-03）**；个股自选进 Phase 2 AC14 | 个股需要自选清单输入；小孙原话「个股自选先不加」 |
| D9 | 凭证管理 | — | 密钥+**收件人白名单**走 `.env` 人工填；板块开关/发送时间等非敏感走 config | Iron Law §3；收件人属外发边界（德彪 r1 P2-3 消解 AC10/D9 冲突） |
| D10 | 发送幂等语义 | 严格 at-most-once / at-least-once 有界重试 | at-least-once 有界重试（attempted→sent 双态 ledger + 未知态补发 1 次 + ≥2 转人工） | SMTP 无 exactly-once；日报偶重复优于静默缺报（德彪 r1 P1-2） |
| D11 | catch-up 机制 | 仅 startup job / reconcile 单入口 | `reconcile(businessDate)` 幂等单入口 ×3 触发（主 cron/startup/每小时安全网） | startup job 不覆盖 leader takeover（德彪 r1 P1-3，scheduler-runtime.ts:223,340） |
| D12 | 出站代理 | 不支持 / 可选 env 代理 | 可选 `MULTI_AGENT_DIGEST_PROXY`（回退标准 HTTPS_PROXY），undici ProxyAgent；def.direct 双 transport | smoke 实测：Node fetch 不吃 proxy env，7 源大陆直连不通；ESPN/HLTV 反而要直连+简单 UA（实现期，2026-07-03） |
| D13 | 启用门 | 默认开 / 默认关 / 存在性门 | SMTP 凭证齐（.env 配置即意图）或 `MULTI_AGENT_DIGEST_ENABLED=1` 才注册调度 job；`=0` 强制关 | startup job 会在 boot 真跑 → 测试/CI/未配置环境必须默认不打真网（实现期） |
| D14 | Phase 2 可选源开关 | — | X 直采 env 存在才注册（`_X_HANDLES` + 任一数据路凭证），默认 disabled | 账号清单/凭证都是小孙人工件；未配置不产生失败噪音（实现期） |
| D15 | 板块纯化 | 保留五板块 / 纯化 | **删篮球/电竞/股市三板块（小孙拍 2026-07-03「让我们纯粹一点」）**，终态=AI/X/热点/GitHub 周榜 | 聚焦 AI 主线；已交付代码（10 源+watchlist+交易日逻辑）整体下线，教训沉淀 D12/git 历史 |
| D16 | X 数据路线 | A=TwitterAPI.io 按量 / B=cookie 小号免费 / C=仅 smol.ai recap | **B 为主（小孙拍 2026-07-03「我弄个小号」）**：自建 RSSHub Twitter 路由消费小号 cookie；A 保留为备路（配 key 优先）；C 始终兜底 | 免费；cookie 不经本进程（只在 RSSHub 实例侧）；参考项目同款姿势，封号风险用专用小号隔离 |
| D17 | 邮件视觉版式 | 报纸头版 v3 / Bento 大小格 / 双列卡墙 / 杂志格子 | **Bento 大小格混排 + 顶部导览（②，小孙 2026-07-04 拍板「可以 不错」）**：深金刊头 + 导览卡（今日速览 + 4 板块锚点格）+ 每板块 hero 大卡 + 其余两列成对/落单整宽；暖金 token 锁定（禁冷色，对齐 dashboard-rank） | 「一格一个」有设计感；顶部导览减少下滑；固定像素多列（272+16+272）防错位；注入护栏不变（渲染器 v4 `e87b78c`，德彪 r5 GO） |
| D18 | 编辑门禁与推理语义 | renderer 补齐 / 唯一发布清单 | **唯一发布清单（B027，小孙 2026-07-13 拍板）**：邮件、web curated、shown ledger 只消费编辑批准 ID；“推理”仅指大模型推理/部署/服务，突出但不独占 AI 板块 | 修复有限 feed 审核后 raw rest/直出流回流，以及 cap 前截断造成的推理假空；确实无合格推理允许为空 |
| D19 | 开源榜单准入与排名 | AI 权重混排 / 双轨榜 / 准入后真实增星排序 | **保持单一“开源榜单”与四组原名；AI 准入后按真实增星排序（B028，小孙 2026-07-13 拍板）**；增长/新秀记跨日状态，周/月不跨日抑制 | 双轨榜被否决为太乱；AI 相关性是准入条件，不是排名倍率；邮件格局和现有榜单排版不改 |
| D20 | 编辑语义判定 | 继续补正则 / 强依赖双 Claude / 可审计的多目标+单 provider 降级 | **B032 采用证据化两阶段：正常模式双 Claude 独审 + 固定 Codex 裁关键分歧；Claude provider 全部失败时，Codex clean-room A/B/C 以 `degraded_same_target` 明示降级；代码从类型化 basis 派生决定，摘要只看 publish 集** | 小孙拍板否决正则补丁，并明确当前 Claude 不可用不能导致方案失败；同模型 clean-room 不冒充多模型独立性，但比恢复正则或整报停摆更符合可用性边界，最坏账仍低于 14d |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-02 | 小孙提需求；4 路并行调研（AI/股票+邮件/体育+热点+GitHub/仓内摸底）完成 |
| 2026-07-03 | Kickoff；小孙拍 D3=QQ SMTP、D8=Phase 1 大盘+市场要闻（个股先不加）；派范德彪设计审 |
| 2026-07-03 | 范德彪设计审 r1 NEEDS-WORK（3 P1 + 5 P2）→ 全接：设计合同 v2 落盘（SafeHttpClient/幂等状态机 D10/reconcile D11/fetcher 合同/LLM 护栏/AC12 渲染验收）→ **r2 GO，Design Gate 通过**（1 条非阻断术语统一已修：ledger=attempted 计数+sent 唯一终态） |
| 2026-07-03 | 实施计划落盘 `docs/plans/F037-daily-news-digest-plan.md`（15 Task，TDD） |
| 2026-07-03 | 小孙拍「不只 Phase 1，整个 feature 一起做完；需要人工的先不管」（凌晨 /goal 授权自主夜跑） |
| 2026-07-03 | **Phase 1 实施完成**（worktree feat/F037-daily-digest，15 Task 全过）：commit 链 `8dfc77f`→`82ab087`→`54ffce9`→`36e885a`；157 测试全绿；真网 smoke **26/26 源全绿**（ai=2763/hot=173/basketball=104/esports=75/stocks=51/github=33 条）；实现期决策 D12-D14 | 
| 2026-07-03 | 派范德彪 Phase 1 code review r1（安全底座标准，含 TOCTOU/代理路径/信任锚三残余主动交代）；并行推进 Phase 2 新模块（x-provider 骨架 + watchlist 行情多源 fallback，12 测试绿） |
| 2026-07-03 | 范德彪 r1 NEEDS-WORK（1P1+4P2）→ 全修 `91f2046`：P1 跨触发点并发互斥+并发回归测试；summarizer 无 pick 整体降级/代理日志脱敏/账本先于 sent-marker/白名单 byte-equal。同 commit 交付 **Phase 2 全量**：AC13（5eplay/thepaper+自建前插+transport 级 fallback）/AC14（watchlist 腾讯→新浪多源）/AC15（XProvider+TwitterAPI.io 骨架），三者 env 存在性开关默认 disabled（D14） |
| 2026-07-03 | r2 NEEDS-WORK（1P2：代理 catch 分支泄露原串）→ 修 `1f14193`（safeOrigin 预计算+3 回归）→ **r3 GO（无 findings，德彪沙箱实跑新增测试 3/3）**。整 feature 代码侧完成：173 测试全绿/typecheck 0/真网 smoke 28 源全绿。残余人工件：.env 凭证/活体 smoke（AC12 活体项）/RSSHub 容器（本机无 Docker）/X key+自选清单（可选）/merge 拍板 |
| 2026-07-03 | 小孙看 smoke 预览四连反馈：① 骨架丑（restyle `9fae3a2` 后仍打回「太难看了」→ **报纸头版风 v3 重设计**：白卡/衬线刊头/双细线/金色编号/中文源名）② **拍 D16 X cookie 小号路线**（翻查 last30days=浏览器 cookie+Bird/XAI key、Agent-Reach=twitter-cli→OpenCLI cookie 兜底后三选一）→ 落 createRsshubXProvider + resolveXConfig 双模 ③ **拍 D15 板块纯化**：删篮球/电竞/股市 10 源+watchlist 模块+交易日逻辑 ④「引用源这么少」→ 源轮转多样性（diversifyBySource：防大体量 feed 刷屏）+ 清单版每板块 6→10 条。133 测试全绿 |
| 2026-07-03 | 本批落 `9fae3a2`+`0ffecf2`（gate 全过，真网 smoke 18 源全绿）→ 派范德彪 **r4 GO（无阻断 findings）**：scope cut 无悬空引用/allowlist 残留、X 双模 fail-closed（无「配一半意外启用」组合）、渲染重写护栏完整（canonicalUrl 单一链接源+escape 全覆盖+空 summaryZh 占位）、diversifyBySource 边界正确。唯一非阻断=本行测试数口径（132→133，已改） |
| 2026-07-04 | 小孙对邮件视觉连续打回（「一长条没设计感」/「没对齐错位」）→ ultracode workflow 并行选型收敛到 **② Bento 大小格混排**（暖金锁定），小孙拍板「可以 不错」；追加「顶部加导览、不想一直往下划」→ 导览卡（今日速览概述 + 4 板块锚点格）。**渲染器 v4 落 `e87b78c`**（D17）：renderer.ts 视觉层重写为 bento+导览，注入护栏一字不动（链接只从 itemsById 取/escapeHtml 全覆盖/safeHref/无 script·远程图·flex-grid·oklch/固定像素多列防错位）；真渲染器输出 playwright 截图自查对齐干净；全量 3670/3672 绿/tsc0/biome0 |
| 2026-07-04 | 派范德彪 **code review r5 GO（零 findings）**：7 条挑刺清单逐条 PASS 且 file:line 实证（护栏未改丢/邮件合规/bento 分格边界连续无跳号/导览计数与渲染同源/github 路径/degraded·notes·源健康语义/markdown 平行输出），德彪重跑 renderer 单测 9/9。**剩余=纯人工件**：.env（SMTP 三变量 + 可选 X handles/RSSHub base）/活体 smoke（AC12）/acceptance-guardian（配活体证据一并跑）/merge 拍板 |
| 2026-07-04 | **全链活体打通 + AC12 PASS**：小孙装 Docker 起自建 RSSHub（`diygod/rsshub` + 小号 cookie，`wsl --update` 解 WSL2 报错）→ 验 `/twitter/user/karpathy` 真 RSS + X provider 抓真推；填主仓 .env（SMTP+RSSHUB_BASE+X_HANDLES）→ `bootDailyDigest()` 真发信 `sent degraded=false`（LLM 全跑通、含 X 板块）到 Gmail 收到。**union rebase 到 origin/dev**（唯一冲突 scheduler-bootstrap.ts = biome import 排序，取 MonthlySnapshot 超集 import 去重；后 9 commit 干净重放；3720/3722 绿）。**AC10 增强多收件人（小孙点名）**：`_TO` 逗号分隔 → parseRecipients（去空白/去空/去重）+ 白名单逐地址 fail-closed（大小写仍敏感）；nodemailer `to` 逗号发全部。全量 3723/3725 绿 |
| 2026-07-05 | **P0 扩源 8 路 + 质量四层 + 分栏改版 + 网页版 + 设置页全链 + P1 收口**（`b0ea28e`/`a1ef5eb`/`184ee1d`/`a9498d3`/`5895cd0`/`1b9e019`/`f420fe1`/`5d608dd`/`9aff853`/`75e7ff4`/`6a93299`，详录=discussions §7）：信源主表 v2.1 立唯一真相源；engagement 贯穿/跨源合并 alsoItemIds/两段式深读/刊头体检行；网页 /digest 真 tabs + summary.json 归档；设置页 runtime-config 段热生效+立即补发；#28 YouTube 六频道/#30 HN 评论富化/#29 LinkedIn 活探判死；X 33 验活账号代配（小孙授权）。范德彪批次 A r1 NO-GO→`72349e9`→**r2 GO**；批次 B r1 NO-GO→`61405d8`→**r2 GO**。华为邮箱第二收件人 18:31 真发 |
| 2026-07-06 | 首跑纠偏 `26eba5d`：keepIf 全滤「健康空」≠ 失败（安静频道误报 failed 是所有 keepIf 源共性雷）→ parse 契约 {parsedCount,items}，**范德彪 r3 GO**（+`98fb7e9` 契约注释同步）；00:23 第二封真发 86KB；X 覆盖率之谜定案=33 账号零失败、仅 5 人 24h 发推（公司官方号低频是常态） |
| 2026-07-07 | **批次 D 六件套** `46e6a00`（社区动态板块/GitHub 中文化 translateExtras/月榜常驻/vllm+vllm-ascend releases 双源/板块标题层级/速览治理）+ **批次 E 内容治理** `a48901d`+`0000ab3`（小孙七问：7 天新鲜窗+shown 已见账本根治跨日重复 2881/3178、政治词表+提示词规则 7 双滤、v2ex 科技聚焦、四榜常驻、Gmail 102KB 字节口径+密度阶梯）；超时 120→240s `f27adb4`；v5 截断降级 → `6f9a251` repairTruncatedJson 括号栈修复（护栏不豁免）v6 补发；德彪批次 D r1 NO-GO→`bbe3f93` 三修→r2 併入 DE 合并审（codex 配额墙 07-09 解锁） |
| 2026-07-10 | **德彪 DE 合并审四轮收敛：批次 D GO + 批次 E GO 零 findings**（`d7b5634` 三修/超时 360s `5b36cfc`/看门狗 600→3600s `3d03093`+`283123c` 三入口锁值）；小孙四问 → 字体提档 `c59966b`+release 时效窗 72h→7 天 `feba9d2`（vllm-ascend 发版漏报根因）→ **r-final holistic 终审**（小孙点名：前端整体+全链方案+review 覆盖盘点=30 实现 commit 9 批全覆盖）**NO-GO 4P1+4P2** → 全修 `5831cf3`（md 链接注入/shown 同日并集/修复缺节记账/邮件红线/网页口径与 scheme 门/tab 假空态）→ r2 全 CONFIRMED-FIXED+2 新洞 → 签名重写+保守合同 `b4b3d32` → **r3 GO 零 findings**；X 机构组 +claudeai/claudeDevs `7835270`（RSSHub 验活；裸 claude=路人坑）；**P2 源五拍收口**（#31 小红书转 F029 当 UGC 核查源/#32 B站收档/#33#34 播客开工=合并后第一批/#35 FB·IG 收档/#29 判死维持，详录=discussions P2 段+§8）；当日 3 封真发（02:53 清单版超时首发→360s 修→03:14 `95317824` 96KB；17:13 `3073d4f8` 97KB 新字体+shown 并集 86→140 活体证）；feature doc 收口 |
| 2026-07-11 | **#33/#34 转写批（小孙改拍「现在搞」不等合并）三 commit**：播客速递 `5c3bbd1`（小宇宙 4 播客 RSSHub enclosure 直链→下载白名单+150MB 顶→ffmpeg 16kHz mono 32k→STT→Claude 提炼→「有新集才出现」板块；转写缓存分层=transcript 先落盘提炼失败下轮只补、单轮 cap 3 集、超 3h 跳过；job/renderer/web 直渲流仿 github，shown 账本跨日去重）+ YouTube 字幕深读 `6dfc64a`（yt-dlp 字幕优先喂 deep-read fetchContent 钩，18K 喂入闸；未装 ENOENT 记忆化静默关闭；Whisper 音频兜底不做留案）+ **STT provider 通用化 `7b90541`**（小孙 Groq 注册被地区拦「does not belong to any organizations」→ 切硅基流动 SenseVoiceSmall 免费档；STT_API_KEY/BASE/MODEL 三变量，段长 5400→3300s 两家门通吃，自定义 BASE 直连）；ffmpeg 8.1.2 winget 代装 + .env 三行小孙明确授权代笔（单次授权不成先例）；**活体验证全链通**：硅谷101 76min 集 68s 跑完（27,949 字转写 + 6 要点带嘉宾归属），缓存 `77bd748e2de7ecec.json`；测试 +34（全套 313→347 绿）。同日扩源 `8a20209`（小孙「多加一点 AI 影响大的」：播客 4→8 家/YouTube 6→12 频道全验活，@Anthropic=路人坑；yt-dlp 429 硬化 --sub-langs 收窄+--sleep-subtitles 3，活体=Dwarkesh 883KB vtt）+ yt-dlp 2026.07.04 代装。**德彪转写批四轮审收敛 GO**：r1 NO-GO 11 条→`8acd214`→r2 NO-GO 6 条→`739d996`（haiku-runner +signal 取消贯通）→r3 NO-GO 1 条→`590778f`（凭证脱敏长度降序）→**r4 GO 零 findings**（德彪自跑注入实验实证双脱敏）；收敛 11→6→1→0，详录=discussions §7 item 11 |
| 2026-07-11 | **小孙六问批（`d7fd5a8`+`7257180`）**：①收件人互不可见=**BCC 密送**（to=发件人自身+bcc=真实清单，newsletter 惯例；mock .eml 同姿态；allowlist/账本口径不变）②X「都是转贴」初版直接滤被小孙二拍打回（「有价值应该找到原帖贴上去」）→ **改版=保留+如实归属+落原帖**：xHeadline 标题「@转推者 转推 原作者: 原文」；api 路线 retweeted_tweet 直构原帖 URL+原推全文；rsshub 无原推 id（07-11 实测 link=转推 status/description 无原帖 URL）维持转推 status=X 登录态自动落原帖；当日转推 38 条/轮 ③**未成年人内容防护**：UNSAFE_CONTENT_RE（色情/赌博/毒品/暴力犯罪细节，与政治词表同机制同 400 字符口径；自杀/枪击类刻意不进硬表防误杀 AI 安全产业新闻）+job 预滤接线+summarizer 规则 7 扩「内容红线」④答疑：haiku=runtime 模块名（haiku-runner）不进邮件；发送时间+全链 LLM 模型设置页已可配（buildRunOverrides 每轮现读热生效；STT 模型例外走 env）⑤验证发信 20:55 `61c080dc` degraded=false：**播客 3 集真转写**（硅谷101 E242/What's Next S10E20/乱翻书 269；ffmpeg 走绝对路径注入——winget PATH 新进程坑）+预滤 3269→389+**101KB 压 Gmail 102KB 线**（降密度到 0 行仍超预算，观察项：picks/X caps 合并后再议）；测试 +11。**德彪三轮审 GO（3→1→0）**：r1 3P2（转推挤轮转队列/retweeted_tweet 错型伪链接/治理语境词误杀）→`b30753c`→r2 1P2（回归测试不咬人+原创版历史债）→`085b31e`（红测实证）→**r3 GO 零 findings**；详录=discussions §7 item 12 |
| 2026-07-11 | **晚二批（小孙「再发一封+起 preview 看设置页」+「设置页不在前端里？」）**：①preview 双进程 API :8807/Web :3107，设置页截图自查**抓漏**→`022512e` groupSources ORDER 写死四类把 podcast 源静默吞（设置页无播客开关可关）——+podcast 组对齐邮件板块序+分组测试 ②第二封 06:21Z `7f6e9d75` degraded=true **新降级形态首例**：summaryZh 引 V2EX 标题带未转义英文双引号炸穿 parse（repairTruncatedJson 只兜尾部截断兜不了中段裸引号）→`07efed7` prompt 规则 2 加字符串值内英文双引号禁令（引用一律中文引号「」）；若再犯升级 jsonrepair 裸引号修复 pass（观察项）③**主界面 header 📰 日报入口 `4a1e98b`**——档案馆拍板（07-05）连带把设置页漏出动线，主站零入口只能手敲 URL；现 📰→/digest（自动跳最新期）→页内 ⚙ 设置 ④第三封 06:43Z `d3790159` **degraded=false 全 LLM 版**（引号禁令首战生效）；三小修未单独派审（纯 UI/prompt 文案/分组，随合并前 guardian 零上下文验收兜底）。**坑：TaskStop 杀外壳不杀 node 子进程——旧 next dev 继续占端口新实例 EADDRINUSE、页面照常 200（陈旧代码假活）；重启 preview 必须按端口 PID 杀真进程（后端 tsx 非 watch 同理，改 registry 必重启 API）** |
| 2026-07-11 | **小孙四问收尾**：①清单版=兜底设计答疑（三降级实案三修：截断→repair/超时→360s/裸引号→prompt 禁令；再犯升级 parse-fail 单次重试，观察项）②**设置页摘小红书编辑面 `ab74fac`**（#31 转 F029 时只休眠后端 UI 忘摘——关键词文本域/凭证 chip/源开关三处摘，xhsKeywords 数据面原样往返零行为变化，适配器留存；其余界面逐项核无死面）③数据尺寸实测答疑：~2.4MB/天（大头 items.jsonl 2.3MB=F029 语料底料）+transcripts 累计 472KB，**.runtime 不进 git 项目零增长**，年 ~850MB 磁盘；留存策略（如底料 90 天轮转）待小孙拍 ④YouTube 答疑：当日 45 条 yt 条目进池、**3 条被精选**（GPT-5.6 速评/ARC-AGI-3/Claude 思维层次）；「邮件底部两个视频」=Gmail 对正文 YouTube 链接的自动预览卡非我们嵌入；视频条目 ▶ 标识待小孙拍 |
| 2026-07-11 | **小孙三拍批 `4cd5fa2`**：①**摘要重试+宁缺勿发**——summarize 失败自动重试（MAX_SUMMARIZE_ATTEMPTS=4：首次+3 重试，对齐小孙「可以重试3次」；runner 内另有 primary→fallback 双保险）→ 4 次全败返回 null **不再降级清单版**；job 判 null → 新状态 `failed_summarize` **不发+pushAlert 告警**（sent marker 未落，下一整点 reconcile 安全网自动重跑）；**飞书私聊告警=合并后接线项**（F040 IM 代码不在本分支基线——scheduler-bootstrap.ts:642 digest pushAlert 现=log.warn，合并 dev 后升级为 F040 私聊出站）；**看门狗 3600→7200s** 三入口（daily-digest/reconcile/startup）+锁值测试同步——新最坏账 540(X fetch)+4×720(summarize)+780(深读)+720(翻译)=4920s，**改任何一腿超时/尝试次数必重算这笔账** ②数据留存小孙拍「不用自动清理」零动作 ③**YouTube 源名标注**：source-labels 12 频道 label 加「YouTube · 」前缀（label=唯一源名出口，精选卡/速览行/md/网页/设置页全消费面一次生效；不加 ▶ 单独条目标识）；outcomeLine +failed_summarize 人话；测试：summarizer +3（4 次全败双形态 calls=4/第 2 次救回 calls=2 degraded=false）+13 处 null 窄化守卫、job failed_summarize（不发+告警+账本不落）、scheduler-config 锁值 7200、settings-model outcomeLine——API 68/68+web 21/21 双 tsc 零。**第五封验证发信 07:32Z `c38ab7ab` degraded=false**（TO 双址 gmail+huawei/BCC 密送；板块账 ai12·hot8·社区12·gh59·播客4；YouTube · 前缀正文实证 5 频道；一次尾截断 repair 救回未触发重试=机制原地待命）；**坑：手动发信 shell 探不到 winget 用户 PATH——yt-dlp ENOENT 深读回落原摘要（设计内降级），下次发信命令加 `MULTI_AGENT_DIGEST_YTDLP_PATH` 绝对路径注入（同 FFMPEG_PATH 坑）；真 runtime 走 start-project 用户会话 PATH 正常** |
| 2026-07-12 | **三拍批德彪四轮审 → §17 TAKEOVER → 闭环**（小孙点名补审——我漏派了，认账）：r1 NO-GO 3P2+1P3（failed_summarize 被 cron 适配层标绿/看门狗 4920 账漏 podcast 900+YouTube 字幕腿+SMTP/失败测试没锁副作用/yt 前缀无需求级测试）→`d49e19c`（失败态收敛 job.ts DIGEST_FAILURE_STATUSES+编译期穷尽红测证/SMTP 三段超时/job 测试零副作用+二轮真重跑/yt 枚举锁）→ r2 NO-GO 2P2（偏离点裁决=要原症状集成回归；socketTimeout=无活动窗非总时限——德彪翻 nodemailer 源码实证）→`623a5d9`（bootstrap 集成回归 failed_summarize→trace failed+SMTP 总 deadline 120s+账 5670 常量推导）→ r3 NO-GO 1P2（transport.close 够不着 sendMail 内局部 SMTPConnection=ghost send 重复邮件，smtp-transport:158/:420 实证）→`ad380ac`（弃 transport 层：MailComposer 组 MIME BCC 仅进信封+自持 SMTPConnection 直发+deadline 真杀 socket+greeting 契约测试）→ r4 NO-GO 2P2 **触发家规 §17 TAKEOVER**（login/send err+QUIT 无响应+成功路径终态 close 全悬空；fake close 伪调 send cb=假绿，真类只清 actions+emit end）→ handoff 四件套→**德彪 danger-full-access 实现 `91c2607`**（closeOnce 幂等+finally 全终态收口；fake 对齐真类 end 语义；真 SMTP 状态机契约三场景 AUTH 535/QUIT 扣响应/DATA 扣 250）→ **我独立复审 PASS**（tsc 零+专项 17/17+定向 74/74 独立复跑+红测抽验注释 closeOnce 7 红恢复绿+守护报告 7/7 门禁）。**看门狗终账=5670s**（源 max 900+摘要 2880+深读 1050+翻译 720+SMTP deadline 120；此前行的 4920/5760 为历史快照——r1 漏并发源 max 与 SMTP、r2 的 210 段和不构成总上限）；SMTP at-least-once DATA→250 模糊窗口按既有 retry 语义保留（无幂等键）。**教训：①fixture 必须按真类行为写不是按期望写（fake close 伪调回调=三轮假绿根因）②连接治理要全生命周期终态收口，不是只治 deadline 单路径③全套回归撞出的 wiki-scanners/compile-fn 两败=dev 基线债（stash 实证，非本分支引入），合并 gate 知情** |
| 2026-07-12 | **检讨文批（小孙报 yt 精选卡「正文仅为样板…无法提炼」元评论）四轮审闭环 GO**：根因三层=yt RSS snippet 全空（第一轮凭标题进精选）+深读字幕失败回落 http 抓 YouTube 页（JS 渲染页只有版权样板且过 200 字闸）+深读 LLM 面对样板写检讨文。**环境两行小孙授权代笔**：主仓 .env +YTDLP_PATH/+FFMPEG_PATH（winget 绝对路径验活）。**三修 `6e6b2a1`**（深读后置摘除门：yt pick 无深读产出→摘除降速览/boot fetchContent 空串语义禁 http 回落/双 prompt 元评论禁令）→ **德彪 jtw-r1 1P1+1P2+1P3**（P1=单 pick section 摘空被 renderer 一刀切 filter 整类蒸发+shown 照烧=永久漏报，他独立探针实证；P2=测试手写 mock 绕开 boot 接线；P3=断言只咬关键词）→ **修批+小孙增强 `10a0640`**（rest-only section 保留+hero guard+**repairDropped 丢节类目例外仍蒸发**——截断事故要回补，语义冲突是既有测试红了才撞出；makeYtDeepReadFetchContent 适配器单点；完整指令断言；**yt 24h 延迟窗**=小孙「我在意 直接做」：yt 发布 <24h 本期完全不进不烧 shown、字幕就绪次日进、可见窗第 2~7 天；yt-dlp 子进程注 ffmpeg PATH——第六封实测 YTDLP 生效但 yt-dlp 探不到 ffmpeg 套娃坑）→ **r2 2P2**（速览容量 0 时空壳+烧账复现——超预算自动降 0 也触发；ffmpeg 读全局 process.env 绕 bootEnv 契约）→`d923a43`（保留门补容量条件+容量 0 烧账注释明确为既有语义；ffmpegPath 走 YtSubsDeps 注入+子进程 env 三态回归）→ **r3 1 finding**（N 谓词过宽缺 usedIds：唯一候选被跨板块 alsoItemIds 占用时空壳复现）→`0887454`（谓词与 restAll 完全同式+占用场景回归含板块头断言）→ **r4 GO 零 findings**（真值表核完+反例推演六路不破）。**第六封 11:22Z `8f8464d5` degraded=false=摘除门活体首秀**（「ai 摘除 1 条无字幕 yt 精选」）；红测四轮（摘除门/rest-only filter/usedIds/穷尽检查）；**坑：perl 多行替换红测 mutate 误伤两处同型谓词（吞类目条件）——红测 mutate 一律 Edit 单点，perl 只用于可 grep 验证的单点替换**；第二批候选=media:description 补抽（无字幕视频有真简介可依） |
| 2026-07-12 | **深夜双批+合审闭环**：①**字幕命中率批 `b6f5058`**（第七封 429 破案→小孙拍 D）：YouTube 登录 cookies 提权（小孙小号导出→主仓 .runtime/secrets/、.env 第三行授权代笔；argv 只路径/未配匿名 fail-open）+`--js-runtimes node` 钉死+429 退避 30s 重试一次+stderr 窗 2000 优先抓 ERROR 行+看门狗账 5670→5970（字幕腿 210s×3 常量推导）②**内容质量批 `345b006`**（小孙两反馈：社区收求助帖「专科大二迷茫」/Reddit 名人八卦、推理栏混 GPU 循环融资）：根因=prompt 规则 6 写了「算力芯片」+速览行是渲染层直出 LLM 选材管不到——推理定义收紧（仅限技术，商业新闻→公司名/其他）+规则 1 community 五类性质不选+`COMMUNITY_NOISE_RE` 结构层词表（只扫标题/只限 community/「离职薪资」产业用词刻意不收防误杀）+**communityDropIds 语义反选**（LLM 反选性质不合格条目，速览行剔除；parse 白名单+renderer category 双保险+picks 优先）③**德彪合审 r1 两批 NO-GO（2P1+1P2 全带独立复现）**：cookie 值可经 yt-dlp stderr 回显进日志/community 喂样 36 上限第 37+ 条无从反选=未审八卦补位/恶意 snippet 可诱导整版蒸发→**三修 `1e7af65`**：cookies 模式失败信息=安全枚举（枚举保「429」兼容重试判定；未配模式保留 ERROR 行）+`communityFedIds` 审查集合闭合（喂样即视野，速览候选限 fed 内「未审=不上」；保留门与 restAll 共用同一 `communityRestBlocked` 函数）+job 层反选熔断（∩fed 占比 >80% 作废+告警）→**r2 GO**（P1/P2 零；德彪独立复跑 40 条原场景 r1RestIds=0+secretLeaked=false+三例外无回归；P3 流程项=subject 缺签名，squash 时补齐拍板不重写历史）④**第八封 15:11Z `22a5a517` degraded=false**：反选首弹 15/36=42% 全真噪声零误杀（情绪帖/名人 meme/@sama 互怼推）+**推理栏对照实证：同一篇 Nvidia/CoreWeave 融资文第七封「推理」→本封「其他」**+社区噪声预滤上链 3206→320+预算护栏首弹 109KB 自动降密度 97KB；cookies 字幕实弹=本期无 yt pick 测不到（延迟窗+摘除门正常形态）挂观察项；测试 131→157、红测五发（restAll 谓词/category 限定/cookies 分支/fed 闭合/熔断阈值 mutate 均红）；审档 .runtime/reviews/F037-hitrate-quality-* 全套 |

| 2026-07-13 | 小孙报最新日报仍有非 AI V2EX 人生帖、推理栏再次消失，并追问其他栏目是否同类绕过；对齐后拍板 B027/B028 按 Bug 流程推进。终态合同：发布清单唯一真相源；推理专指大模型推理且突出不独占；开源榜单保持原名/四组/现有排版，AI 准入后按真实增星排序，周/月不跨日抑制，增长/新秀记上榜状态；双轨榜与邮件两行改版均明确不做。计划见 `docs/plans/F037-editorial-quality-hardening-plan.md`，正式 reviewer 指定 Claude Opus 4.8。 |
| 2026-07-13 | **B027/B028 实现进入质量门禁**：结构化审核 + `DigestPublicationV2` 收口 mail/web/archive/shown，推理/非推理稳定精选与终态裁剪双门禁；GitHub 四榜 `yes/no/unknown` 准入后真实增星排序，增长/新秀仅标状态不隐藏，周/月无跨日抑制；四榜全部请求共享并发闸，SafeHttp abort 覆盖 DNS/fetch 且失败缓存可重试。专项 115/115、全量 E2E 11/11、typecheck/build/lint/diff gate 通过；独立验收与 Claude Opus 4.8 正式 review 待执行，故 B027/B028 仍为 verification。 |
| 2026-07-13 | **B027/B028 Bug 流程闭环**：独立 acceptance-guardian PASS；Claude Opus 4.8 首轮正式 review GO（0 P1/P2、1 P3），唯一 P3 为更强 GitHub evidence 跨榜替换保留旧 `Map` 插槽导致新秀榜错位，经 RED→GREEN 于 `12624e8` 修复，同模型定点复审确认 CLOSED、无新增 P1/P2/P3、最终 GO。实现提交 `3dc1f1d` + `12624e8`；F037 相关 API/Node 254/254、web model 18/18、Playwright 11/11、全量 components 901/901。邮件格局、原有文案、总名“开源榜单”和四组均未改；本分支未合并。 |
| 2026-07-13 | **B029 真实补发阻塞闭环**：首次 `force reconcile` 的三份摘要均为合法 JSON，但稳定漏审被引用 hot 条目并引用 policy-rejected community；四次盲重试后 `failed_summarize`、零 SMTP。修复保持 strict parser 不变，只向下一轮追加内部 ID 级定点纠错；RED→GREEN、独立 review 0 P1/P2、acceptance-guardian PASS。第二次真实运行首稿被拒、下一稿修正后 `status=ok / degraded=false`，外发账本 21→22、六文件归档落盘。该轮 37 个源受瞬时网络/DNS 与本机 ffmpeg/PATH 异常影响，四榜未成节，故邮件可验 B029 与内容门禁、不可作为 B028 四榜完整样本；本分支仍未合并。 |
| 2026-07-14 | **B030 跨 provider 兜底进入实现**：FFmpeg 修正后的隔离预检为 42/43，唯一失败 `podcast-transcribe` 已定位到 STT 完成后的 LLM 提炼；主摘要同时全败。根因是主力/备用都走 Claude CLI，组织关闭 subscription access 时同故障域失效。拍板保留原两列与邮件呈现，增加固定第三层 `Codex gpt-5.6-sol/high`，摘要、翻译补全、播客共用；设置页只读展示，不新增可持久化字段。计划见 `docs/plans/F037-cross-provider-fallback-plan.md`；验证与补发待完成。 |
| 2026-07-14 | **B030/B031 质量门禁推进**：三层 provider-aware runner 与 Codex 子进程取消完成；真实预检再暴露统一 360s 误杀慢 Codex、旧看门狗漏算第三层、parse-fail 原因不可观测。首次 guardian 又抓到原始 provider stderr 旁路，敏感哨兵双 RED→GREEN 后日志/聚合错误只保留安全分类。第二 guardian PASS 后，专项 timeout 审计继续抓到播客 120s Claude + 900s 整源会把 2h Codex 截成 ≤15min；再以四项 RED→GREEN 统一播客 Claude 30min/层、Codex/high 2h、整源 12h，并把全链最坏账重算为 108750s、三个入口 watchdog 129600s。隔离全链 17m52s：43/43、首稿 6 个 policy-rejected 引用、第二稿通过，最终 `status=ok/degraded=false`、三份播客、六件归档+mock 邮件。内容审计社区9/9、AI推理6/16且非推理10/16、四榜19/19 yes；全量门禁与 F037 E2E 通过。新增 timeout 修正的复验/review/补发仍待执行。 |
| 2026-07-14 | **B030/B031 review 修复**：Guardian R3 先行 PASS；指定 Claude Opus 4.8 CLI 随后被组织策略拒绝（无 API/Bedrock/Vertex/Foundry 备用通道），备用零上下文 review 判 2P1+2P2：两个 Claude 配置位可被固定 Codex slug 折叠、Windows Claude timeout/abort 只杀 shell、community pick 过信模型 assessment、GitHub `mcp` topic 与 Minecraft Coder Pack 歧义。四项均以反例 RED 后最小修复：API/存储/运行三层锁 Claude 拓扑，Claude 整树终止，publication 用原始事实做最终门，`mcp` 需正文消歧；目标 58/58、扩展定向 310/310。排序、四榜、跨日状态及邮件格局未变；代码变化后新 guardian/复审/补发待执行。 |
| 2026-07-14 | **B031 Guardian R4 二次收口**：R4 证明“AI 实体 + 描述性原文”仍不足以区分实质讨论与个人生活性质；三个模型伪标反例（AI offer 选项征询、加班薪资抱怨、ChatGPT 相亲闲聊）均穿透 publication，故判 BLOCKED。反例先 RED 6/7；最终 publication 改为在模型审核后再次复用原始标题社区性质门，并新增两类高置信组合信号，GREEN 7/7、邻接 59/59，vLLM/SGLang 推理讨论正例保留。没有改栏目、邮件格局、榜单排序或去重语义；全新 R5/复审/补发待执行。 |
| 2026-07-14 | **B031 最终门与极宽保险丝再收口**：备用复审发现个人性质可藏入 `rawSnippet`，GPT/vLLM 长纯赞叹仍可借“长度 + AI/技术词”穿透；同时过宽生活/加班词会误杀真实推荐模型评测与 CUDA 故障复盘。新增原症状和反误杀 RED 后，最终门改为“AI/技术信号 + 发布事件/事实动作/技术细节”，正文个人噪声只在成对高置信叙事下硬拒绝；vLLM/SGLang 调度、Blender MCP 构建、相亲推荐模型 A/B 研究均保留。按小孙“慢也要等”的新拍板，Claude/Codex 单层保险丝扩为 6h/12h，播客下载/ffmpeg/STT 为 30m/30m/1h、整源 96h，三入口 watchdog 14d；保守全链最坏 864750s。新 guardian/复审/真实补发仍待完成。 |
| 2026-07-14 | **Guardian R6 blocker 与 production-path 补强**：R6 的九例终态探针证明 CUDA 故障诊断虽未被“加班”噪声门拦截，仍会因实质门不识别“排查/定位/batching/竞态”而降为 `low_signal`，故判 BLOCKED。把该正例加入与五类反例、其余三类正例相同的 `buildDigestPublication` 用例，先 7/8 RED，再最小补入诊断动作与竞态细节后 8/8；邻接 62/62、全量 API 4633/4635（0 FAIL）。R6 结论不原地改判，须全新 R7 与新复审后才能真实补发。 |
| 2026-07-14 | **B032 Design Gate（小孙拍板停止正则补丁，并补充 Claude 故障可用性约束）**：真发审计发现 Sakana “share our latest research” 被 `shares?` 当 finance；与 R4-R7 的反例穿透/正例误杀构成系统性摆动。D20 将审核与摘要拆分、类型化 basis + 原文 evidence；正常双 Claude + Codex 争议裁决，Claude 全部 runner 失败时固定 Codex clean-room A/B/C 且明示 `degraded_same_target`，不能因当前 Claude 不可用整报失败。composer 只见 publish 集；外层 schema v2、邮件/榜单/单腿 timeout 不动，降级全链最坏 `778350s < 14d`；未放行前不补发。 |
| 2026-07-14 | **B032 Bug 流程放行**：证据化 Decider→DecisionSet→Composer 落地，Claude 全挂注入矩阵 7 正/7 反与真实 `gpt-5.6-sol/high` clean-room smoke 通过；DecisionSet 在 job/publication 重算 hash、重验 evidence/slot 并从 votes 重建。零上下文 Guardian 独立回放旧归档与篡改探针后 PASS（专项 171/171、packages 4557/0、components 903/903、Chromium 2/2）。独立 Codex review 首轮抓出 empty-output 误触降级、重复 reviewer slot 可伪造授权 2P1，均以正式 RED→GREEN 修复；原攻击 probe 2/2、聚焦 176/176，定点复审两项 CLOSED、最终 GO。Claude Opus 4.8 因组织策略不可用，本轮没有冒充 Claude review；真实补发待最终运行门。 |
| 2026-07-14 | **B032 真实补发闭环**：首轮 force 运行耗时约 15 分钟，两个 Claude target 在审核与成稿阶段均失败后，由固定 `gpt-5.6-sol/high` 高推理兜底完成；终态 `status=ok / degraded=false`，DecisionSet 如实标记 `degraded_same_target`。ledger attempt `1→2`、outbound `23→24`、六件归档刷新并含新 SMTP messageId。成品 AI 15 条（推理专栏 1 + 推理速览 1，其余 13），社区头条另有 vLLM 推理工程、14 条社区内容无 V2EX 人生求助，“开源榜单”及增长/周榜/新秀/月榜四组未变。小孙随后明确要求再发一封查看，第二轮于 22:44 同样成功，attempt `2→3`、outbound `24→25`；本轮 43/43 源正常、AI 12 条中有 EAGLE-3/vLLM 推理进展、社区 15 条且 V2EX 0、四榜 19 项、播客 1 条。 |
| 2026-07-14 | **B033 首发可靠性施工**：小孙指定 2026-07-15 07:30 为第一封正式日报，去重从该日开始。RED 复现 B032 Composer 漏掉 5–8 条合同、YouTube 瞬时 404/500 无重试、07-14 试发 shown 污染首发；GREEN 落地动态速览合同与终态门禁、YouTube opt-in 单次重试、`2026-07-15` 去重 epoch。旧 shown 数据不删，邮件版式/文案/开源榜单与 GitHub 语义不动；待全量门禁、Guardian、review 后当日合入。 |
| 2026-07-15 | **B033 / F037 正式合入**：最终 SHA `57c54fc` 经全量门禁、独立 Guardian PASS 与零上下文复审 GO 后，以单提交 fast-forward 直接合入 `dev`（按小孙要求不走 PR）。首封正式日报仍定于 07:30，旧试发 shown 保留但不参与首发过滤；本次正式发送成功后写入的 shown 自 07-16 起成为跨日去重基线。 |
| 2026-07-16 | **B035 经典 Outlook 邮件视觉兼容进入 verification**：07-16 正式日报在手机端正常、Windows 经典 Outlook 明显失真，根因是 Word HTML 引擎与原 renderer 的圆角、百分比行高、`div/span` 间距、DPI 和字体回退不兼容。修正版保留暖白配色、深色刊头、标题层级、卡片结构与正文，只增加 MSO 96-DPI/exact line-height/`bgcolor`/SimSun、动态 VML 刊头，并把关键视觉间距迁到 presentation table/td；hero/wide/col 卡片扁平化，卡片字体栈在外层继承并由 MSO 规则显式落到单元格。现代客户端保留 `overflow-wrap`/`break-word`，长 ASCII 标题在 Outlook 条件样式中改用 `break-all`，不改可复制文本。07-16 原归档只读重渲染校验 Markdown、可见文本、52 个展示 ID、62 个 href 顺序与八个归档/ledger hash 不变，HTML 78,458 bytes <98KiB。独立验收纠正了旧 fixture 少算 4 个仓库的问题：生产真上限为 34 正文 + 22 仓库 + 4 播客共 60 条；renderer 只在速览已降为 0 后仍超预算时自适应缩短 HTML 摘要，按 Unicode code point 保证 emoji 完整，标题、链接、展示集合和 Markdown 不变，60 条 publication 路径为 97,673 bytes；若异常上游标题令最终 HTML 仍超 98KiB，job 在归档和 SMTP 前 fail-closed。因本机 Office 安装损坏，最终 Classic Outlook 视觉需由仅投递小孙本人邮箱的修正版实机确认。 |
| 2026-07-19 | **B037 信源与 Outlook 幽灵留白修复合入**：smol-ai 仅单源响应预算提升到 3 MiB；Digg 兼容 `storiesByFilter.top.posts/items` 并在 canonical 解析 0 条时 fail-closed；Outlook 风险双列卡降级为顺序整宽。最终 SHA `b9f2b180` 经 quality-gate、零上下文 Guardian PASS、peer review Approved（P1/P2=0），PR [#5](https://github.com/BailanCaptain/Muti-Agent/pull/5) squash merge 为 `1a447c7e`。GitHub Test job 的 5 个失败与 base/dev 精确同集、B037 新增测试全绿，baseline exception 已在 PR 留痕；定向 2026-07-19 shadow 重建与单收件人补发随后执行。 |
| 2026-07-20 | **B038 启动环境缺失修复完成并补发**：00:37 API 重启后 F037 启用门为 false，运行时仅注册 `7 cron / 1 startup`，因此 07:30 没有进入抓源、生成或 SMTP。修复以 `8fd4ef3c` 直接 fast-forward 合入并推送 `dev`：只从根 `.env` 窄读 `MULTI_AGENT_DIGEST_*`，进程环境逐键优先且显式 `0` 保持关闭；同一 env 快照贯穿 gate/runtime/scheduler/routes，禁用日志只记录固定 reason。TDD、全量门禁、Guardian 与 peer review 全部通过。13:34 精确重启后恢复 `9 cron / 2 startup`，13:35 取得 leader term 42；13:38 仅触发一次正式 send-now，13:57 以 `status=ok`、`degraded=false` 完成。2026-07-20 归档 6 个文件、43/43 信源健康，attempt ledger `attempts=1/sent=true`，outbound ledger 35 → 36，正式 7 人收件清单（含用户指定邮箱）无重复投递。 |
| 2026-07-22 | **B039 Outlook 开源榜单字体与标题层级修正进入 verification**：小孙反馈 Classic Outlook 中 GitHub 榜单字体与上文不一致，并指定四榜标题应与“科技从业者 / 推理”子标题同层。根因是 GitHub 独有嵌套 table 依赖 Word 跨表字体继承，且榜种标题在 `ghListCard()` 内单独拼接。修复复用 `subHeading()` 把增长/周/新秀/月榜标题独立成行，并在内层 table 与全部文字节点显式锁定现有 SANS；不改条目、排序、caps、链接、Markdown 或配色。定向 `104/104`、组件 `903/903`、typecheck/build/lint 与 2026-07-21 生产归档守恒重放通过；HTML `92,534 < 100,352 bytes`。真实 Outlook 与 07:30 发信/信源健康待当日实收监控。 |
| 2026-07-22 | **B040 X 信源本机 RSSHub 代理错路由进入 verification**：7 月 21/22 连续 35/35 `SafeHttp[network]`，而 RSSHub 容器运行、1200 监听，失败时请求没有进入容器；同轮 thepaper 本机 RSSHub 首跳也失败后由备用源恢复。根因是显式 ProxyAgent 不消费 `NO_PROXY`，`makeXSource` 又没有把 orchestrator 既有 `httpDirect` 传给 RSSHub provider。修复仅让 loopback cookie/RSSHub 路线使用 direct；远端自建 RSSHub 与 TwitterAPI.io 保持代理，不改 `.env`、Cookie、容器或发送账本。首轮 peer review 抓出的远端 RSSHub 回归已按 RED→GREEN 收窄 transport 边界；定向与邻接 `88/88`、全量门禁、Quality Gate、独立 Guardian 和 reviewer 复核全部通过，最终 `75797c12` 已 fast-forward 合入并推送 `dev`。项目 API 已换新进程并恢复 `9 cron / 2 startup`、leader term 45；仍待 2026-07-23 正式日报确认 `x-firsthand` 状态正常且条目数大于 0。 |
| 2026-07-22 | **B041 Classic Outlook 摘要导航间距稳定化进入 verification**：小孙反馈“AI 前沿 / 社区动态 / 今日热点”与右侧计数标签在 Classic Outlook 中被拉得过远。根因是摘要导航使用 100% 双列表格但没有固定布局和标签列宽，Word 渲染引擎会按右侧内容重新分配首列；07-22 归档中三行空隙约 93–100px，且随内容漂移。修复只给内层 presentation table 加 `table-layout:fixed`，把左侧标签列锁定为 64px，右侧仍自然换行；不改文字、计数、链接、顺序、Markdown 或配色，并用真实三行样例建立结构回归。定向 `105/105`、typecheck/lint/check/build 与全量 `pnpm test` 均通过；真实归档重放守恒 67 个 href、55 个 displayed ID、6 个 rest ID 和 Markdown，HTML `87,335 < 100,352 bytes`，独立 Guardian PASS、peer review Approved（P0–P3=0）。最终 `039b9c98` 已 fast-forward 合入并推送 `dev`，项目 API/Web 重启后均为 HTTP 200；exact-recipient 修正版仅发指定单人，marker=`sent`、outbound ledger `38→39`，正式归档与状态账本不变。实际 Classic Outlook 观感仍待小孙实收确认。 |
| 2026-07-23 | **B042 Digg 嵌套摘要 schema 漂移进入 verification**：正式日报 43 源中仅 `digg-ai` 失败；生产同姿势页面与 RSC 均完整，`top.posts` 有 25 条，但 Digg 把根级 `title/tldr` 迁到 `summary.title/summary.description`，B037 的人工 `posts` fixture 没覆盖该嵌套形态。修复保持根级字段优先，只增加 nested fallback，不放宽 `clusterUrlId`、JSON 边界或 parser-zero fail-closed；首轮 RED 为 `9 pass / 1 fail`、GREEN 为 `10/10`。Peer review r1 的 3 P2 经二轮 `11 pass / 2 fail → 13/13` 收紧 nested 类型边界、补持久化合同矩阵并同步信源主表 v2.3（`40 → 40`）；修补后 diff/typecheck/lint/check/build、API 全量与组件 `903/903` 全绿，实时只读抓取再次规范化 15 条。最终 Guardian PASS、peer review `Approved / LGTM`（`P0–P3=0`）；次日正式信源健康仍由既有 F037 监控实收。 |
| 2026-07-24 | **B043 共享代理瞬断雪崩修复完成**：07:30 正式日报 43 源中 24 failed + 1 timeout，Clash sidecar 同秒记录 27 条相同上游 deadline，排除 Cookie 与单源 parser 故障。RED→GREEN 落地 group-aware 保序就绪调度（全局最多 6、blocked group 不占槽、同 key 预聚合）、YouTube `1 / 1.5s` 组闸、source-bound AbortSignal、同底层 client wrapper 复用、单 source 共享一次 GET retry token，以及主站限定的 `www ×2 → m ×1` 官方硬上限。终审抓出的 worker convoy、同 key 顺序依赖、direct alias 重复请求和 parser-zero 后 mobile token 四个边界均以回归闭合并获 Approved；最终 shadow `43/43 ok`、无 SOURCE ALERT、非降级、HTML 81,353 bytes，正式 archive/health/ledger/shown/config 哈希不变；Quality Gate 5,632 tests 中 5,630 pass、0 fail（另 1 skip、1 todo）。 |

## Links

- Discussion: [F037-daily-digest-sources-research.md](../discussions/F037-daily-digest-sources-research.md)（信息源逐个实测验证 + 排除清单 + 方法论借鉴）
- Plan: [F037-daily-news-digest-plan.md](../plans/F037-daily-news-digest-plan.md)（Phase 1 = 15 Task）
- Hardening: [F037-editorial-quality-hardening-plan.md](../plans/F037-editorial-quality-hardening-plan.md)（B027/B028）
- Bugs: [B027](../bugReport/B027-digest-editorial-bypass.md) / [B028](../bugReport/B028-github-ranking-ai-eligibility.md) / [B029](../bugReport/B029-digest-summary-schema-parse.md) / [B030](../bugReport/B030-digest-cross-provider-fallback.md) / [B031](../bugReport/B031-digest-slow-fallback-and-opaque-rejection.md) / [B032](../bugReport/B032-digest-semantic-regex-oscillation.md) / [B033](../bugReport/B033-digest-first-production-launch-readiness.md) / [B035](../bugReport/B035-outlook-classic-email-rendering.md) / [B037](../bugReport/B037-digest-sources-outlook-whitespace.md) / [B038](../bugReport/B038-digest-boot-env-disabled.md) / [B039](../bugReport/B039-outlook-github-headings.md) / [B040](../bugReport/B040-rsshub-proxy-routing.md) / [B041](../bugReport/B041-outlook-subnav-spacing.md) / [B042](../bugReport/B042-digg-nested-summary-schema.md) / [B043](../bugReport/B043-digest-egress-burst-failure.md)
- Cross-provider fallback: [F037-cross-provider-fallback-plan.md](../plans/F037-cross-provider-fallback-plan.md)（B030）
- Evidence-based editorial gate: [discussion](../discussions/F037-evidence-based-editorial-gate.md) / [plan](../plans/F037-evidence-based-editorial-gate-plan.md)（B032）
- Related: [F029](F029-research-verification-pipeline.md)（外发数据边界设计参考）

## Evolution

- **Evolved from**: 无
- **Blocks**: 无
- **Related**: F029（外发边界思路复用：allowlist + 敏感强确认 + 外发记录）
