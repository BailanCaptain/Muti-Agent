---
id: F037
title: 日报邮件推送系统（DailyBrief）
status: spec
owner: 黄仁勋
created: 2026-07-03
---

# F037 — 日报邮件推送系统（DailyBrief）

## Why

小孙原话（2026-07-02）：

> 我想要做一个日报推送系统，每天把相关信息发送到我的邮箱，发送的格式先是摘要，然后是各类精准来源。覆盖面：1、体育板块：篮球新闻，电竞新闻；2、AI板块：当前AI的最新新闻，重点在大模型推理的相关工作和新闻上，特别是受关注的优化点，还有训练等等（参考 https://news.smol.ai/ ）；3、热点新闻；4、股票市场相关的新闻（参考 https://github.com/ZhuLinsen/daily_stock_analysis ）；5、每周github热榜（根据星级增长速度，和一周内星星总数，和AI相关的skill、MCP最好）。必须参考：信息源=各大AI公司官网、各大AI公司以及相关从业者的X（一手动态）；https://github.com/mvanhorn/last30days-skill ；github.com/Panniantong/Agent-Reach 。你也可以自己发挥下想象力。

现状痛点：信息散在 X / 官网 blog / 虎扑 / 热榜 / GitHub trending 各处，每天手动刷，无法稳定覆盖「推理优化/训练」这类垂直信号。

## What

每天定时（默认 07:30 Asia/Shanghai）自动生成一封**中文 HTML 日报邮件**发到小孙邮箱：

- **版式**：顶部「今日速览」（LLM 跨板块总摘要）→ 五大板块分节（AI / 热点 / 篮球 / 电竞 / 股票），每条 = 标题 + 一句话中文摘要 + 来源名 + 原文链接
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

## Acceptance Criteria

### Phase 1 — MVP：管道骨架 + 五板块基础版（零部署依赖源）

- [ ] AC1: 每日 07:30（Asia/Shanghai）自动生成并发送日报到配置收件箱；进程当时不在线 → 启动后补发；按日幂等（一天最多一封，重启不重发）
- [ ] AC2: 邮件版式 = 「今日速览」总摘要 → 板块分节（每条：标题+一句话中文摘要+来源名+原文链接）→ 页脚源健康状态
- [ ] AC3: AI 板块：smol.ai 全文 RSS + 官方 blog（OpenAI/DeepMind/Mistral + Anthropic/Meta 社区桥）+ HF Daily Papers API + vLLM blog/SGLang releases + HN 高分 AI 帖；LLM 按「推理优化/训练」加权排序，优化点单独突出
- [ ] AC4: 热点板块：知乎热榜 + 百度热搜 + 头条热榜（直连 JSON）+ BBC 中文 RSS
- [ ] AC5: 体育板块：篮球（ESPN NBA + Yahoo NBA RSS；虎扑经可用 RSSHub 公共实例尽力接入）+ 电竞（虎扑电竞尽力 + Dot Esports + HLTV RSS）
- [ ] AC6: 股票板块：A 股快讯（东财/新浪 JSON）+ 美股（Yahoo Finance + CNBC RSS）；非交易日自动缩减；范围按 Design Decisions D8
- [ ] AC7: GitHub 周榜（周一版）：scrape `trending?since=weekly`（权威周增数）+ Search API `topic:mcp/claude` 新贵子榜 + AI/MCP/skill 加权；OSS Insight 仅兜底名次（其 star 数字禁止进正文）
- [ ] AC8: 可靠性：单源失败隔离（独立超时/try-catch）不影响整报；同源连续 3 天失败推 R-201 告警
- [ ] AC9: 归档：每日 markdown + html 落 `.runtime/daily-digest/YYYY-MM-DD/`
- [ ] AC10: 安全边界：出站域名白名单 + SSRF 基线（拒 loopback/私网/重定向逃逸，Iron Law §4 对齐）；收件人白名单（.env）；SMTP 凭证 .env 人工填、代码只读（Iron Law §3）；每次外发落账本（时间/收件人/各板块条数）
- [ ] AC11: LLM 降级：runner 降级链全挂时发「原始条目清单版」，不丢当日报

### Phase 2 — 增强（Phase 1 验收后按需拍）

- [ ] AC12: 境内自部署 RSSHub（chromium-bundled）：虎扑篮球/CBA/电竞、5EPlay、澎湃、微博热搜；fallback 链 自建→rssforever→ktachibana
- [ ] AC13: 个股自选分析（daily_stock_analysis 式：行情多源 fallback + LLM 决策报告）
- [ ] AC14: X 一手动态直采（TwitterAPI.io/官方按量，供应商抽象层可随时切换）——花钱项，小孙拍

## Dependencies

- 邮件通道凭证（QQ SMTP，D3 已拍）：小孙人工操作 —— QQ 邮箱网页版 → 设置 → 账号 → 开启「IMAP/SMTP 服务」（短信验证）→ 取 16 位授权码，然后 `.env` 加三行（Iron Law §3，代码只读）：
  - `MULTI_AGENT_DIGEST_SMTP_USER`=QQ 邮箱地址
  - `MULTI_AGENT_DIGEST_SMTP_PASS`=16 位授权码
  - `MULTI_AGENT_DIGEST_TO`=收件箱（bailan.captain@gmail.com）
  - host/port 代码默认 `smtp.qq.com:465`（非敏感不进 .env）。**Phase 1 活体发信前置阻塞项**（开发/测试用 mock sender 不阻塞）
- GitHub PAT（免费，推荐：Search API 10/min → 30/min）
- 无阻塞性 Feature 依赖；Related: F029（外发边界设计参考，其代码未落地不可依赖）

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
| D8 | 股票范围 | 大盘+市场新闻 / 含个股自选 | **Phase 1 只做大盘+市场要闻（小孙拍 2026-07-03）**；个股自选进 Phase 2 AC13 | 个股需要自选清单输入；小孙原话「个股自选先不加」 |
| D9 | 凭证管理 | — | 密钥全走 `.env` 人工填；板块开关/收件人/时间走 config | Iron Law §3 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-02 | 小孙提需求；4 路并行调研（AI/股票+邮件/体育+热点+GitHub/仓内摸底）完成 |
| 2026-07-03 | Kickoff；小孙拍 D3=QQ SMTP、D8=Phase 1 大盘+市场要闻（个股先不加）；派范德彪设计审 |

## Links

- Discussion: [F037-daily-digest-sources-research.md](../discussions/F037-daily-digest-sources-research.md)（信息源逐个实测验证 + 排除清单 + 方法论借鉴）
- Related: [F029](F029-research-verification-pipeline.md)（外发数据边界设计参考）

## Evolution

- **Evolved from**: 无
- **Blocks**: 无
- **Related**: F029（外发边界思路复用：allowlist + 敏感强确认 + 外发记录）
