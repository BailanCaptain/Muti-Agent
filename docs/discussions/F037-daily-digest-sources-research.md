# F037 日报推送系统 — 信息源与技术方案调研

> 调研日期：2026-07-02 ｜ 方法：4 路并行 agent（AI 板块 / 股票+邮件 / 体育+热点+GitHub / 仓内摸底），信息源逐个真实 fetch 验证
> 标注：✅ = 当天实测验证 ｜ ❌ = 实测确认不可用 ｜ ⚠️/🔶 = 二手来源或部分验证 ｜ ⚪ = 推断
> 注意：✅ 均为单日单次实测，非长期稳定性保证；中文热榜接口均为非公开承诺接口，需每源独立容错 + 告警。

## 一、仓内基础设施摸底（复用性结论）

| 能力 | 现状 | 结论 |
|---|---|---|
| 周期调度 | ✅ 成熟：`SchedulerRuntime`（croner + leader lease + reentrancy guard + job_trace + R-201 告警），`scheduler-bootstrap.ts` 装配 11 job | 直接复用；新 job 三步：`scheduler-config.ts` 加 cron 行 → `scheduler-bootstrap.ts` 装配 → `server.ts` 注入依赖。范本 `scheduler-bootstrap.ts:497-515`（nightly-health-check） |
| digest 分层 | ⚠️ `weekly-draft-digest.ts` 有 scan→build→push 干净分层，但 `pushDigest` 通道未接线 | 抄结构，push 通道自写 |
| LLM 摘要 | ✅ 成熟：`haiku-runner.ts`（createOpusRunner:159 等）+ `runner-with-fallback.ts:62` + 结构化 client 范本 `production-compile-llm-client.ts:41`；三引擎可配 `wiki-compile-runner.ts:98` | 直接复用 |
| 外部 HTTP 抓取 | ❌ 无 fetch 范式、无 SSRF 模块（唯一 node:http 用于 MCP loopback 回调） | 从零写（原生 fetch/undici + 域名白名单 + SSRF 基线） |
| 外发数据边界 | ❌ F029 仅 spec 零代码 | 自建轻量版，借 F029 思路（allowlist + 敏感强确认 + 外发记录三件套） |
| 邮件发送 | ❌ 无 | 从零写（nodemailer） |
| 配置 | ✅ 双通道：runtime-config JSON（非敏感偏好）/ `.env`（密钥，Iron Law §3 人工填，代码只读） | SMTP 授权码放 `.env`；板块开关/收件人等放 config |

- 调度语义：cron 表达式（默认时区 Asia/Shanghai）、`windowMinutes` 错过窗口自报 `missed_window`、`StartupJobRegistration` 支持启动补跑 —— 天然支持「机器 07:30 不在线 → 启动后补发」。

## 二、AI 板块信息源

### smol.ai AINews（`https://news.smol.ai/rss.xml`）✅

- swyx/Latent Space 旗下工作日日更；结构 = **AI Twitter Recap**（基于 544 账号 X 策展 list，~8000 词）+ **AI Reddit Recap**（12 个 subreddit）。Discord recap 已死（2026-06-30 期原文确认官方切断，作者预告"new AINews soon"，管线需容忍改版）。
- RSS 为**全文**（content:encoded），但 **feed 只保留最近 2 条** → 必须日抓不能补漏。
- 定位：AI 板块骨架 + X 信号最经济来源（等于免费享用 544 账号的 X recap）。

### 官方公司 blog RSS（✅ 2026-07-02 逐家实测）

| 公司 | Feed | 状态 |
|---|---|---|
| OpenAI | `https://openai.com/news/rss.xml` | ✅ 活 |
| Google DeepMind | `https://deepmind.google/blog/rss.xml` | ✅ 活 |
| Mistral | `https://mistral.ai/rss.xml` | ✅ 活（`/feed.xml` 是 404） |
| Anthropic | 官方无；社区桥 `https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml` | ✅ 活，小时级再生成 |
| Meta AI | 官方无；同 repo `feed_meta_ai.xml` | ✅ 活 |
| xAI | 官网 403；同 repo `feed_xainews.xml` | ⚠️ 条目滞后存疑 |
| DeepSeek / Qwen / Kimi | ❌ 均无 feed（Qwen 旧站 feed 停更 2025-09，死源勿用） | 改盯 HuggingFace org 页 + GitHub releases.atom |

### 推理优化 / 训练专项（✅ 逐个实测）

| 源 | 接入 | 备注 |
|---|---|---|
| HF Daily Papers | `https://huggingface.co/api/daily_papers?date=YYYY-MM-DD` API | ✅ 免 auth，含 upvotes/summary/arXiv id；「今日热论文」最佳单源（`papers/rss` 是 401 别用） |
| vLLM blog | `https://vllm.ai/blog/rss.xml` | ✅ 唯一活路径（blog.vllm.ai 老域名全 404）；仅摘要 |
| SGLang | `github.com/sgl-project/sglang/releases.atom` | ✅ lmsys.org blog 无 RSS 且客户端渲染，releases 是唯一编程入口 |
| FlashInfer | `flashinfer.ai/feed.xml` + `releases.atom`（过滤 nightly-*） | ✅ |
| HF blog | `https://huggingface.co/blog/feed.xml` | ✅ 仅 title+link，量大需关键词过滤 |
| arXiv | `https://rss.arxiv.org/rss/cs.CL` `/cs.LG` | ✅ 原始流，只做关键词兜底 |
| SemiAnalysis | `https://newsletter.semianalysis.com/feed`（Substack） | ✅ 老 WordPress /feed 冻结在 2025-09 勿用；部分付费 |
| Hacker News | `https://hn.algolia.com/api/v1/search_by_date?query=LLM&tags=story&numericFilters=points>100` | ✅ 免 key；注意 `/search` 端点带 numericFilters 已 400，必须用 `search_by_date` |

### X/Twitter 一手动态现状（2026-07）

- 官方 API：免费/Basic/Pro 档已死，纯按量（读 post $0.005/条），日报场景 ≈ $45/月，无免费入口。
- Nitter 公共实例 ✅ 实测全灭（6 实例 7 次全拒）；RSSHub Twitter 路由需自建 + cookie，封号风险。
- 三方按量：TwitterAPI.io（$0.00015/read，月 $1-3）/ Apify —— 可靠但 ToS 灰色，须做供应商抽象随时切换。
- Bluesky 官方 API 免费（IP 3000 req/5min）✅，学术侧覆盖可，公司官宣主阵地仍在 X。
- **结论：Phase 1 白嫖 smol.ai 的 X recap；真要一手直采再上按量三方（Phase 2+，小孙拍钱）。**

## 三、股票板块

### daily_stock_analysis（ZhuLinsen）拆解 ✅

- Python + FastAPI + React 工作台；每交易日拉自选股行情+新闻 → LLM 决策报告 → 14 渠道推送（邮件走 smtplib，按域名自动配 SMTP，multipart 纯文本+MD→HTML）。
- 行情：多源 fallback（AkShare/Tushare/efinance/腾讯/通达信/Baostock + YFinance/AlphaVantage/Finnhub/长桥）；**新闻不走爬虫走 AI 搜索 API**（Tavily/SerpAPI/博查/SearXNG）。
- LLM：LiteLLM 工厂多提供商；prompt 独立成文件。调度首选 GitHub Actions cron（非交易日跳过 + 手动触发开关）。
- 可借鉴：fetcher 抽象+多源 fallback 链 / Markdown 中间格式渠道各自渲染 / 非交易日跳过 / 通知降噪。
- akshare 的 Node 等价：直连底层 HTTP（腾讯 `qt.gtimg.cn`、新浪 `hq.sinajs.cn` 需 Referer 头、东财 push2 零鉴权）或 npm `stock-api`（zhangxiangliang，内置三源）。

### 新闻源

| 源 | 接入 | 状态 |
|---|---|---|
| 财联社电报 | RSSHub `/cls/telegraph/:category` | ✅ 路由在，需可用 RSSHub 实例 |
| 东方财富 | 7×24 快讯页 JSON / push2 接口（零鉴权）🔶 | 非官方承诺，被大量项目多年使用 |
| 新浪财经 7×24 | `zhibo.sina.com.cn/api/zhibo/feed?...zhibo_id=152` 🔶 | 多博客交叉印证 |
| 雪球热帖 | RSSHub `/xueqiu/hots` | ✅ 路由在 |
| Yahoo Finance | `https://feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL,TSLA&region=US&lang=en-US` | ✅ 免 key，多 ticker 逗号分隔 |
| CNBC | `cnbc.com/rss-feeds/` 官方列表 ✅；头条 `/id/19206666/device/rss/rss.html` 🔶 | 稳定 |
| Finnhub | REST，免费 60 calls/min | ✅ 日报场景富余极大 |
| Alpha Vantage | NEWS_SENTIMENT，免费仅 25 req/day | ✅ 只当补充 |
| Seeking Alpha | 官方 feeds ✅ 但 Cloudflare 反爬凶 ⚪ | 服务器定时抓可能 403，只做备选 |

## 四、体育板块

### 篮球

| 源 | 接入 | 状态 |
|---|---|---|
| ESPN NBA | `https://www.espn.com/espn/rss/nba/news` | ✅ 当天新鲜 |
| Yahoo NBA | `https://sports.yahoo.com/nba/rss.xml` | ✅ 分析向互补 |
| 虎扑篮球 | RSSHub `/hupu/nba` `/hupu/cba` | ✅ 经 `rsshub.rssforever.com` 实测有效；中文首选 |
| Bleacher Report / The Ringer | RSS 全 404 | ❌ 勿用 |
| 新浪 NBA | RSS 僵尸（冻结 2018） | ❌ 勿用 |
| 腾讯体育 | 无编程入口（RSSHub 无路由，源码确认） | ❌ |

### 电竞

| 源 | 接入 | 状态 |
|---|---|---|
| 虎扑电竞 | RSSHub `/hupu/all/all-gg`（覆盖 LoL/KPL/无畏契约/CS2） | ✅ 坑：pubDate 是 Invalid Date，去重用链接/标题 |
| 5EPlay | RSSHub `/5eplay/article`（CS2 中文专业编译） | ✅ |
| Dot Esports | `https://dotesports.com/feed` | ✅ 分类 feed 403 不可依赖，全站 feed + 关键词过滤 |
| HLTV | `https://www.hltv.org/rss/news` | ✅ RSS 端点未被 Cloudflare 拦；固定 UA+低频+容错 |
| Dexerto | `/esports/feed` 纯但约周更 | ✅ 补充位 |
| 王者荣耀官方 | RSSHub `/tencent/pvp/newsindex/ss` | ✅ 更新慢，KPL 公告补充 |
| 微博电竞 / 新浪电竞 | 公共实例全挂 / 频道荒废 | ❌ |

## 五、热点板块

| 源 | 接入 | 状态 |
|---|---|---|
| 知乎热榜 | `https://api.zhihu.com/topstory/hot-list` | ✅ **匿名 200 完整 JSON**（RSSHub 新路由名 `/zhihu/hot`） |
| 百度热搜 | `https://top.baidu.com/api/board?tab=realtime` | ✅ 匿名 200，50 条最规整 |
| 头条热榜 | `https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc` | ✅ 匿名 200，字节接口偶改版 |
| 微博热搜 | 直连 ❌（403/cookie）；经聚合层（NewsNow）✅ | 需自建 RSSHub+浏览器 或 NewsNow |
| 澎湃 | RSSHub `/thepaper/featured` | ✅ 多公共实例 200 |
| BBC 中文 | `https://feeds.bbci.co.uk/zhongwen/simp/rss.xml` | ✅ 唯一验证通过的中文官方 RSS |
| 联合早报 | 中国网络直连 200，海外 IP 被拦 ⚠️ | 经 NewsNow 可用 |
| Reuters 中文 | 已关站 | ❌ |

热榜聚合项目：**NewsNow（ourongxing/newsnow，20.9k star 活跃）** ✅ 公共 demo 六源全通（海外 IP 被 Cloudflare 拦，需国内网络）、可自部署 —— 首选聚合层；DailyHotApi ⚠️ 维护放缓 + demo 挂，仅自部署备选；momoyu.cc ✅ 零部署但个人站，仅兜底。

## 六、GitHub 周榜

| 方案 | 结论 |
|---|---|
| scrape `github.com/trending?since=weekly` | ✅ **唯一权威「N stars this week」**；服务端渲染 HTML 可直接解析；官方从无 Trending API |
| GitHub REST `/repos/{owner}/{repo}` | 取 topics/description 做 AI/MCP 加权（免费 PAT：core 5000/hr） |
| GitHub Search API | `topic:mcp created:>7d sort=stars` 做「AI 新贵子榜」（新仓总星≈周增星）✅；匿名 10/min，带 PAT 30/min；**拿不到存量仓周增速** |
| OSS Insight API | ✅ 免登录 600 req/hr；**排名可信但周增绝对值系统性低估 30-45 倍**（GH Archive 漏采实锤）——只用名次兜底，数字别进正文 |
| gh-trending-api 等第三方托管 | ❌ 全灭（2020 起弃维护） |
| star-history.com | 只有 SVG 图表 API，无 JSON | ❌ 非数据源 |

推荐：周一 cron scrape trending weekly（≤25 repo + 权威周增）→ REST 补 topics → topics ∩ {mcp, model-context-protocol, claude, llm, ai-agent, skills} 加权 → Search API 补新贵子榜 → OSS Insight 兜底（只用名次）。

## 七、邮件投递选型

| 方案 | 额度 | 关键结论 |
|---|---|---|
| ① Gmail SMTP + 应用密码 | 500 收件人/天 | ⚪ **`smtp.gmail.com` 大陆被墙**，家用机定时任务=代理一断当天日报丢 → 排除主选 |
| ② Resend | ✅ 100 封/天免费 | 走 443 无墙问题；无自有域名只能发到注册账户本人邮箱（个人日报恰好合法）；DX 最好 → **备选** |
| ③ Mailgun / SendGrid | Mailgun sandbox 白名单繁琐；**SendGrid 免费档 2025-05 已取消** ✅ | 无增量价值 / 出局 |
| ④ QQ SMTP + nodemailer | 🔶 100 封/天（40/分钟） | **国内直连零网络问题**，5 分钟配置（开 SMTP→授权码→.env）；QQ→Gmail 首日手动标「非垃圾」+建过滤器即解 → **首选** |

HTML 邮件要点：table 布局 ≤600px / CSS 构建时内联（juice 或 React Email/MJML）/ `color-scheme: light dark` + 避免纯黑白底（Gmail 强制反色）/ 涨跌色附 ▲▼ / 中文字体栈 PingFang SC + Microsoft YaHei。

## 八、RSSHub 总体现状（2026，关键依赖评估）

- **rsshub.app 官方实例实质已废** ✅：全路由对非浏览器流量 Cloudflare 403 + 官方声明「仅测试勿生产」。
- 第三方公共实例存活率 ~1/3 ✅：`rsshub.rssforever.com` / `rsshub.ktachibana.party` 健康（大陆直连可达）；志愿者性质无 SLA。
- 项目本体健康 ✅（45k star 当天仍在 push）；全库 3291 路由仅 2.6% 需 Puppeteer；微博是重灾区（需浏览器+cookie），虎扑/澎湃/榜单类完全无障碍。
- 自部署极低成本 ✅：`docker run -d -p 1200:1200 diygod/rsshub`（微博用 `:chromium-bundled` 镜像，内存 ~512MB-1GB ⚪）。境内部署对国内源是加分项。
- 策略：Phase 1 免 RSSHub 或仅用公共实例试探（fallback 链：自建→rssforever→ktachibana）；Phase 2 境内自建。解析 503 错误页区分「路由废」（报警）vs「暂时限流」（重试）。

## 九、方法论借鉴

- **last30days-skill**（mvanhorn）：① entity resolution 先于搜索（先解析 handle/subreddit/org 再发查询）② 并行多源 ③ engagement × relevance × freshness 加权 + **per-author cap=3** 防大 V 刷屏 ④ 跨源聚类合并同一事件 ⑤ LLM 综合逐条 citation。**「免 key 基线（Reddit/HN/GitHub 零 key）+ 付费源增强」分层设计直接适用。**
- **Agent-Reach**（Panniantong）：每渠道多后端优先级 fallback 链 + 安装时活体探测（不只看命令存在，真跑一遍），坏后端给修复处方 —— X 类不稳定源的标准接入姿势。
- **daily_stock_analysis**：Markdown 中间格式 / 非交易日跳过 / 通知降噪（同内容去重）。

## 十、已实测排除清单（勿再踩）

rsshub.app 公共实例、Bleacher Report / The Ringer RSS、新浪 RSS（僵尸）、Reuters 中文（关站）、gh-trending-api 类第三方托管、玩加/掌上英雄联盟 RSSHub 路由（已删）、DailyHotApi 公共 demo（后端挂）、Nitter 公共实例、Qwen 旧站 feed（停更 2025-09）、blog.vllm.ai 老域名、HF `papers/rss`（401）、HN `/search`+numericFilters（400）、SendGrid 免费档（已取消）。
