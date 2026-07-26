# F037 信源全量主表 + 扩展调研定案（v2.4 · 2026-07-27）

> **本表是 F037 信源的唯一真相源**：任何汇报/实现/排期以 §0 主表为准；每次改动必须核计数（上版 N 项 → 本版 N±变更逐条列明），禁止凭记忆手抄重写。
> 失误记录（立表原因）：07-04 两连漏——Digg「调研有、清单漏」、小红书「表格有、队列漏」，小孙连抓两次。病根=每次口头重抄必丢件。
> 背景：小孙 07-04 四问（清单要全/去重方法论/LLM 可配/简报型源防范）+ 07-04 深夜五条修正（设置页 all-in + 4.8 主力/放弃项不同意/GitHub 月榜/后置评估/Digg 补录）。调研=三路 subagent 逐文件过仓（Agent-Reach 93 文件、last30days 34k 行、AINews 全量 RSS 668 期）+ 11 项活体探测。

## 0. 全量主表（40 路：现役 19 + 07-07 增补 2 + P0 新增 8 + P1 三项 + P2 五项 + 管线增强 3）

> **v2.4 计数核对**：上版 40 项 → 本版 40 项。B044 只调整周末发送节奏、#11/#17 周一 lookback 与 #23 Digg 可恢复 HTTP 重试，源数量零增删。
>
> **v2.3 计数核对**：上版 40 项 → 本版 40 项。B042 只同步 #23 Digg 的现行入口与 RSC 字段合同，源数量零增删。
>
> **v2.2 计数核对**：上版 38 项 → 本版 40 项。变更逐条：+#39 vllm-releases、+#40 vllm-ascend-releases（小孙 07-06「我是 NPU 推理的」点名）；存量项零删除。另有**板块字段改值不改件数**：07-06 社区改版（小孙「把 X 一手动态改成社区动态」）#17 x-firsthand、#21 v2ex-hot、#22 reddit-ai、#23 digg-ai、#31 小红书 板块 → community；#27 月榜 每月 1 号 → **每天常驻**（小孙「月榜咋没有了」）。

### 现役 19 路（已在生产管线）
| # | sourceId | 板块 | 接入 | 备注 |
|---|---|---|---|---|
| 1 | smol-ai | ai | RSS `news.smol.ai/rss.xml` | **将升级 contentMode:digest 深读**（近 10 期带 content:encoded 全文；guid 去重，pubDate 是假的） |
| 2 | openai-news | ai | 官方 RSS | 千条档案流，靠源轮转防刷屏 |
| 3 | deepmind-blog | ai | 官方 RSS | |
| 4 | mistral-blog | ai | 官方 RSS | 大陆直连不通走代理 |
| 5 | anthropic-news | ai | Olshansk/rss-feeds 镜像 | |
| 6 | meta-ai-blog | ai | Olshansk/rss-feeds 镜像 | |
| 7 | vllm-blog | ai | 官方 RSS | |
| 8 | sglang-releases | ai | GitHub releases.atom | 滤 nightly |
| 9 | hf-blog | ai | 官方 RSS + AI 关键词过滤 | |
| 10 | hf-daily-papers | ai | HF JSON API（日期回退 1-3 天链） | 论文信号主源（arXiv 直连因此不进） |
| 11 | hn-ai | ai | Algolia JSON（points>100；通常近 24h，周一近 72h + 终态周末日期门） | P1-30 评论 enrichment 待接 |
| 12 | bbc-zhongwen | hot | 官方 RSS | |
| 13 | thepaper | hot | RSSHub（自建优先→公共实例链） | |
| 14 | zhihu-hot | hot | 公开 JSON API | |
| 15 | baidu-hot | hot | 公开 JSON API | |
| 16 | toutiao-hot | hot | 公开 JSON API | |
| 17 | x-firsthand | community（07-06 前 x） | 自建 RSSHub cookie 小号 `/twitter/user/:handle` | B 项已加 4-7s/账号限速+8min 预算；通常近 24h，周一近 72h 后由终态日期门只留周六/周日；33 账号已验活 |
| 18 | github-trending-weekly | github | 刮 `github.com/trending?since=weekly`（常驻；周一周末合辑除外） | PAT 可选补 topics |
| 19 | github-ai-newcomers | github | api.github.com search `topic:mcp created:>7days`（常驻；周一周末合辑除外） | |

### 07-07 增补现役 2 路（小孙 07-06 点名：NPU 推理要多看）
| # | sourceId | 板块 | 接入 | 备注 |
|---|---|---|---|---|
| 39 | vllm-releases | ai | GitHub `vllm-project/vllm/releases.atom` 零 auth | 72h 时效窗防旧 release 每天回流（发版起连续三天可见） |
| 40 | vllm-ascend-releases | ai | GitHub `vllm-project/vllm-ascend/releases.atom` 零 auth | 昇腾 NPU 插件仓；同 72h 窗；含 rc 版（对 NPU 用户 rc 也是信号） |

### P0 新增 8 路（拍板已过，立即实现）
| # | sourceId | 板块 | 接入 | 实测状态 |
|---|---|---|---|---|
| 20 | ai-hot | ai | `aihot.virxact.com/api/public/items?mode=selected` JSON（免 auth 需浏览器 UA） | ✅ 07-04 实测 200；LLM 策展中文 AI（公众号+The Decoder 聚合）；contentMode:digest。**07-07 对账（小孙「怎么一个内容都没看见」）**：在册在用（日抓 ~50 条），条目 canonicalUrl 指向**原始出处**（x.com 等）而非 virxact 页——邮件里看不到 virxact 域名但内容在（07-07 「扎克伯格千兆瓦集群」即它贡献）；此前档案流挤占喂样仅 1 坑，批次 E 新鲜窗后升至 ~5 坑 |
| 21 | v2ex-hot | community（07-06 前 hot） | `www.v2ex.com/api/topics/hot.json` 公开免 key（带 UA）；**07-07 批次 E 挂 keepIf 科技正向词表**（全站热议的生活/职场/理财贴不进社区板块，宁缺勿滥） | Agent-Reach 全端点备案；待接入时验 |
| 22 | reddit-ai | community（07-06 前 ai） | **shreddit svc 免 key**：`www.reddit.com/svc/shreddit/community-more-posts/top/?name={sub}&t=day` 刮 `<shreddit-post>` 属性（真实 score/comments）；浏览器 UA+令牌桶 5rps；子版 LocalLLaMA/MachineLearning/OpenAI/ClaudeAI/singularity | last30days 生产路线（匿名 .json 已 403 死）；arctic-shift 分数备援 |
| 23 | digg-ai | community（07-06 前 ai） | `digg.com/tech/` 页内 Next.js RSC 流提取（`/ai` 仅作网络失败 fallback）：拼接 `self.__next_f.push` 后解析 `storiesByFilter.top.posts`（兼容旧 `items`）；标题/摘要优先根级 `title/tldr`，缺失时回退 `summary.title/description`，nested 错型不强转；用 rank/postCount 排序与展示 | ✅ 07-23 实测 `top.posts` 25 条、规范化 15 条；RSC 格式脆，解析 0 条立即 fail-closed；B044 起 canonical GET 对 429/5xx 与 transport 错误共享且只消费一次 retry token |
| 24 | techmeme | ai | `www.techmeme.com/feed.xml` RSS | ✅ 07-05 实测 200 真 RSS |
| 25 | google-ai-blog | ai | `blog.google/technology/ai/rss/` | ✅ 07-05 实测 200 真 RSS |
| 26 | qwen-blog | ai | `qwenlm.github.io/blog/index.xml` | ✅ 07-05 实测 200 真 RSS |
| 27 | github-trending-monthly | github | 刮 `github.com/trending?since=monthly`，**07-06 起每天常驻**（原每月 1 号；小孙「月榜咋没有了」） | 同 #18 抓取器换参数 |

### P1 三项（实测通/试点通就上）
| # | 项 | 接入 | 状态 |
|---|---|---|---|
| 28 | youtube-ai 频道 RSS | `youtube.com/feeds/videos.xml?channel_id=UCxx` 零 auth（标题级信号，不转写） | **✅ 07-05 已落（`6a93299`）**：Two Minute Papers/Lex Fridman/3Blue1Brown/Fireship/AI Explained/Karpathy 六频道（ID 逐个 curl 实测 200+标题核对）；72h→7 天时效窗防旧片回流；labels/逐源开关/allowlist 自动挂。**07-11 扩至 12 频道 `8a20209`**（小孙「AI 领域影响大的」）：+Dwarkesh Patel/Yannic Kilcher/ML Street Talk/OpenAI/Anthropic/Google DeepMind 官方（坑：@Anthropic=路人 Matt Gregory，官方=@anthropic-ai） |
| 29 | linkedin-lite | Jina Reader `r.jina.ai/<公开页URL>` 免 key 读 AI 公司官方页公开帖 | **❌ 07-05 活探判死降 P2 等待项**：`r.jina.ai/linkedin.com/company/anthropicresearch/posts/` 返回 200 但内容=LinkedIn 登录墙（Title="LinkedIn Login, Sign in"，2.3KB 零帖子）——公开页对无 cookie 抓取已全面收口。按「未活测源不上噪音」纪律不实现；重启条件=官方 API org 权限（人工件）或可用第三方镜像出现 |
| 30 | hn 评论 enrichment | Algolia `items/{objectID}` 给 picks 补 top 评论 | **✅ 07-05 已落（`6a93299`）**：`JsonSourceDef.enrich` 富化钩（自兜错合同）+ `sources/hn-comments.ts`——榜内互动量前 5 拉顶层高质量评论 ×2（剥 HTML/≥20 字/160 截断）拼 snippet，LLM 摘要能看到社区视角；逐帖隔离+整体 fail-open+snippet 2000 上限 |

### P2 五项（设置页之后逐个上，**均不砍**——小孙 07-04 拍「放弃的不同意」；**07-10 逐项重拍收口**：#31 转 F029 / #32、#35 收档 / #33、#34 开工 / #29 判死维持，终态见各行）
| # | 项 | 方案（参考已给） | 等待项 |
|---|---|---|---|
| 31 | **小红书** | xiaohongshu-mcp 常驻 sidecar（自带无头浏览器+**小号扫码**登录，localhost:18060）；频控 2-3s/次；xsec_token 机制=先搜索拿完整 URL 再读 | **07-05 适配器已落**（`sources/xiaohongshu.ts`：MCP tools/call search_feeds + SSE/JSON 双形态信封 + xsec_token 进链接 + 频控 2.5s±1s + 未活测防御解析，激活日真响应锁 fixture；env=`MULTI_AGENT_DIGEST_XHS_MCP_BASE`+`_XHS_KEYWORDS` 配齐即启）。**07-10 转 F029**：小孙拍「日报用不到，F029 当核查源」——keywords 永不配即日报休眠（代码留存已过审不删）；UGC 证据档位/派发判据/共用件提炼见 §8 + F029 记忆「待接输入」段 |
| 32 | B站 UP 主 | RSSHub `/bilibili/user/video/:uid`；**07-05 已查明 503 根因=容器缺 Chromium** → 换 `diygod/rsshub:chromium-bundled` 镜像重建（同端口同 cookie，~1.5GB） | ~~小孙换镜像 → 我验路由 + 出 UP 主候选清单逐个实测~~ **07-10 收档**（小孙「B站可以不用了」）；重启条件=小孙重新点名 |
| 33 | 播客转写 | ~~Agent-Reach 抄本（页面正则抠直链+Groq）~~ 实现比抄本更净：RSSHub `/xiaoyuzhou/podcast/:id` enclosure 直出 `media.xyzcdn.net` 直链（07-10 四家实测 200）→ffmpeg 16kHz mono 32k（>55min 切段）→STT→Claude 提炼→「有新集才出现」板块 | **07-11 落地 `5c3bbd1`+`7b90541`**：默认集=42章经/硅谷101/What's Next/OnBoard!；Groq 注册被地区拦（"does not belong to any organizations"）→ **STT 通用化切硅基流动 SenseVoiceSmall（免费档，07-11 官方定价页核实）**，STT_API_KEY/BASE/MODEL 三变量+自定义 BASE 直连；转写缓存分层（transcript 先落、提炼失败只补提炼）、单轮 cap 3 集、超 3h 跳过、shown 跨日去重；ffmpeg 8.1.2 已装、.env 三行已配（小孙授权代笔）；**活体证=硅谷101 76min 集 68s 全链**（27,949 字→6 要点）；**07-11 扩至 8 家 `8a20209`**：+张小珺商业访谈录/晚点聊 LateTalk/十字路口Crossing/乱翻书（全验活+标题核对）；**德彪四轮审 GO 闭环**（r1 11→r2 6→r3 1→r4 0，修复 `8acd214`/`739d996`/`590778f`，全程见 §7 item 11） |
| 34 | YouTube 视频转写 | yt-dlp 字幕优先（`--skip-download --write-auto-subs`，中文优先中英兜底，走代理）喂 deep-read 当正文；vtt 剥时间戳+滚动重复行去重 | **07-11 落地 `6dfc64a`**：deepRead +fetchContent 钩（null 回落 http 路径）+18K 喂入闸；被 LLM 选中的 yt-* 条目才深读（maxItems 3 有界）；**yt-dlp 未装=ENOENT 记忆化静默关闭（行为同未接线）**，`winget install yt-dlp` 即自动激活——不加人工必做件；Whisper 音频兜底不做（auto-subs 覆盖率 >95%，缺口小成本高）留案；**07-11 扩至 12 频道 `8a20209`**（+Dwarkesh/Yannic/MLST/OpenAI/Anthropic/DeepMind 官方；@Anthropic=路人坑）+429 硬化（--sub-langs 收窄+--sleep-subtitles 3，活体=Dwarkesh 883KB vtt）；yt-dlp 2026.07.04 已代装（小孙授权）；**德彪四轮审 GO 闭环同 #33**（脱敏三轮打磨=argv→env/decoded 变体/长度降序） |
| 35 | FB / IG | OpenCLI 驱动桌面真 Chrome 登录态（`opencli facebook feed` / `instagram explore`）；跑在小孙桌面机技术可行 | ~~小孙拍两件事：用真号还是建小号？关注谁？~~ **07-10 收档**：黄仁勋建议砍（Meta 内容 blog+X 已覆盖 / IG 信噪比低 / 养账号扛风控不值），小孙「这个我听你的」 |

### 评估过不进 F037（每项带理由；标 🔎 = F029 按需检索件，接入方法已备案，见 §8）
- **xai-blog / cohere-blog RSS**：07-05 实测不存在（404/返回 HTML 非 RSS）→ @xai、@cohere 已在 X 33 账号覆盖
- **@bentossell**：X 账号 503（改名/停用），验活失败弃
- **雪球/股票/StockTwits**：小孙 07-03 拍「纯粹一点」删股市板块（如重启走设置页源开关）
- **Reddit 官方 API / 匿名 .json**：前者停自助注册、后者 403 全封（外部现实），被 #22 shreddit svc 替代
- **smol.ai 544 Twitter List 直采**（RSSHub /twitter/list）：量大易封小号，且 #1 AINews 正文 + #23 Digg AI 1000 已双重覆盖聚合信号；可再议
- 🔎 **arXiv 直连**：日报侧 #10 HF daily papers 已覆盖论文信号；F029 逐声明查论文原文用（`arxiv.org/abs/{id}` + export API）
- 🔎 **Polymarket**（Gamma API 免 key `gamma-api.polymarket.com/public-search`，15K req/10s）：预测类声明的市场赔率证据
- 🔎 **Trustpilot**（首次 headless 收 WAF cookie 后回放）：产品口碑类声明核查
- 🔎 **Jobs-ATS 五家**（Greenhouse/Ashby/Lever/Workable/SmartRecruiters 公开 posting API）：公司动向/招聘信号核查
- 🔎 **Exa / Brave / Serper / DDG-HTML 搜索**（端点+参数已在 last30days 报告备案）：F029 逐声明全网检索的主力
- 🔎 **Jina Reader**（`r.jina.ai/<URL>` 免 key 网页→Markdown）：F029 读证据页正文
- 🔎 **arctic-shift**（`arctic-shift.photon-reddit.com/api/posts/ids` Reddit 历史归档）：历史帖证据回查
- 🔎 **HN Algolia 逐条**（`hn.algolia.com/api/v1/items/{id}`）：讨论区证据定位
- **TruthSocial**：需 token 且与我们场景无关
- **小红书桌面 OpenCLI 路线**：被 #31 sidecar 路线取代（服务化更稳）

## 1. 三参考深读硬结论（07-04 三路 subagent，出处见各仓）
- **Agent-Reach**（Panniantong/Agent-Reach，93 文件）：能力路由器非聚合器；**无内置账号清单、无排序去重方法论**（负结论 ×2）；真货=V2EX 全端点/B站 RSSHub 路线（yt-dlp 已被 412 全灭）/YouTube 频道 RSS/Jina Reader/多后端有序降级+真探活分层/小红书 xiaohongshu-mcp、FB/IG OpenCLI 方案（→ #31/#35）。
- **last30days-skill**（mvanhorn/last30days-skill，34k 行）：**Reddit 免 key 真路径 shreddit svc**（→ #22）+ arctic-shift 回填；打分公式全套（流内 `0.65相关+0.25新鲜+0.10互动`、engagement 各平台 log1p 加权、跨平台票数归一 ref 表、RRF K=60、**单作者上限 3/每源保底 2**、近重 3-gram Jaccard≥0.7、聚类实体 overlap≥0.45+MMR λ=0.75）；反封锁（双 UA/令牌桶 5rps/429 独立预算+Retry-After/反爬响应识别）；`<untrusted_content>` 注入围栏；**Digg=di.gg→digg.com AI 1000**（质量先验 0.85，→ #23）。
- **smol.ai AINews**（668 期全量 RSS 实拉）：34.7% 期数标题=「not much happened today」反炒作，价值全在正文（3.5-7k 词/期，73-185 原帖链接）；**rss.xml 近 10 期带 content:encoded 全文**；方法论=「99% agent 生成+人挑版」/4 管线并行人选 1/互动量选材/头部体检行（"We checked 12 subreddits, 544 Twitters"）/双层摘要（description 执行摘要+全文）。

## 2. 质量方法论四层（随 P0 实现）
1. **结构化 engagement**：`NormalizedItem.engagement?: number`（HN points/HF upvotes/Reddit score/知乎百度热度/Digg gravityScore）→ 预排序 + 透出给 LLM 当选材依据
2. **跨源事件合并**：summarizer prompt 升级——同一事件多源 → 一条 pick 主 `itemId` + `alsoItemIds[]`，渲染「N 源同报」徽章；解析 fail-closed 护栏同款
3. **两段式深读**（§3）
4. **头部体检行**：「本期扫描 N 源 M 条 → 精选 K 条」（页脚健康行已有，B 项异常卡已有）
- 诚实边界：RRF 融合/词法相关性引擎**不抄**——那是日吞 30 万词的体量，我们日几百条，LLM 直选+四层足够。

## 3. 简报型源防范（Q4 定案）
病根：summarizer 只喂 title+snippet 前 400 字；smol.ai 类标题无信息量。修法三件：
1. registry 加 `contentMode: "digest"`（#1 smol-ai、#20 ai-hot 首批）——标题视为无信息量必走深读
2. **两段式深读**：picks 敲定后二次取全文（smol-ai 用 RSS content:encoded 零额外请求；其余 SafeHttpClient 抓 canonicalUrl 提正文 ≤12k 字）→ 二次 LLM 产出**中文重写标题 titleZh + 3-5 句提炼**；titleZh 过 sanitize（禁 URL/HTML），链接仍严格 canonicalUrl
3. 通用 guard：任何源 title 过短（默认 <8 字符；15 会误伤正常中文标题）→ 强制入深读队列；白名单外 host 由 SafeHttpClient fail-closed 自动跳过（该条保持原样）

## 4. X 账号验证清单（A 项 · 07-04 本机 RSSHub 逐个活体验证，33 OK / 1 FAIL）
OK（待小孙贴 `MULTI_AGENT_DIGEST_X_HANDLES`）：OpenAI, AnthropicAI, GoogleDeepMind, AIatMeta, MistralAI, xai, NVIDIAAI, GoogleAI, cohere, StabilityAI, perplexity_ai, huggingface, deepseek_ai, Alibaba_Qwen, karpathy, sama, ylecun, DrJimFan, AndrewYNg, gdb, ilyasut, demishassabis, JeffDean, fchollet, hardmaru, _jasonwei, ClementDelangue, alexandr_wang, drfeifei, rowancheung, TheRundownAI, emollick, swyx
FAIL：bentossell（503 弃）

## 5. LLM + 设置页（Q3 拍板落地）
- **已切**：主力 Opus 4.8 + 兜底 Opus 4.7（小孙 07-04 拍板，commit `ceaac55`；原 Haiku 兜底退役）
- **设置页（「前端能配的都做」）**：主/兜底模型自由输入 · 收件人 · X 账号清单 · 小红书关键词（07-05 批次 6 起有 env 位）· 逐源开关 · 发送时间 · 立即补发按钮；DB 真相源 + .env 首启种子（F040 P2.5 渠道页同模式）。**秘密不进前端**（SMTP 授权码/X cookie/PAT 留 .env，页面只显示已配置/未配置）——Iron Law §3 + 泄露面控制
  - **✅ 07-05 已落（后端 `9aff853` + 前端 `75e7ff4` + 德彪修 `61405d8`）**：`/digest/settings` 全量配置面 + 邮件密度（其余速览行数 0-30）+ 立即补发（202+轮询）。**存储决策偏离登记**：真相源用 runtime-config JSON 的 `dailyDigest` 段而非 DB 表——F040（DB 渠道设置）在另一棵未合并 worktree，抄它必埋合并冲突；本仓现成先例是 wikiCompile 全局段（validate 显式 400/sanitize 存储防线/session 拒收全套复用）。`.env 首启种子`语义保留且升级为**字段级**：设置字段缺省回落 .env，前端「与基线相同不落存储」diff（.env 后改还能跟）；改设置**下一轮热生效**（job 每轮 `runtimeSettings()` 现读，不重启）。凭证只出已配置/未配置布尔。

## 6. 拍板记录
- 07-03 小孙：D15 纯粹一点（删股/篮/电竞）；D16 X cookie 小号路线
- 07-04 小孙：② bento+导览版式；多收件人；A/B/C 方向；**五条修正**=①设置页 all-in+4.8 主力 4.7 兜底 ②放弃四平台不同意→分档待拍（#31/#35）③GitHub 月榜（#27）④B站/播客要评估（#32/#33 评估已给）⑤Digg 漏报→补录（#23）
- 07-05 小孙：小红书从队列漏掉二连抓 → 立本主表为唯一真相源
- 07-05 小孙（改版五条 + 前提令）：①排版长短块难看要修 ②源多要分栏可点切换（→邮件静态分组+网页版真 tabs，邮件客户端剥 JS 做不了真切换）③X 授权代配 .env 33 账号（已代改该一行）+分最热/科技公司/科技从业者 ④热点分体育/民生等栏 ⑤AI 栏特别设计=**推理专栏**（大模型推理相关）+其余按公司分类；**后置件往前提，特别是小红书**；手动项先搁置
- 07-05 晚二拍（小孙「日报点开就看完，别逼人跳网页切换」）：**邮件自足原则**——tab 的本质是"有限空间装更多"不是"切换"这个动作；邮件原生三件=①**其余速览**紧凑行区（每板块未精选条目源内轮转 12 行直接印，一行=源名·标题链接·热度）②导览卡**子栏目录**锚点直达 + 每节尾「↑ 回目录」（锚点是邮件唯一可用跳转原语；不认锚点的客户端退化成静态目录，内容零丢失）③时间当切换器（GitHub 增长榜每天/周榜周一/月榜 1 号——日历替用户切 tab）；**网页版降级为档案馆**（全量回溯/F029 语料读取面），不在日常阅读动线上；Gmail 102KB 裁剪线=物理上限，job 95KB 预警；设置页候选项+「邮件密度（其余速览行数）」
- 07-23 B042：Digg canonical 已由 `/ai` 迁至 `/tech/`，集合保持 `top.posts`，copy 迁至 `summary.title/description`；实现保留根级旧字段优先、逐字段 nested fallback 与 parser-zero 提醒卡，源数量 `40 → 40`。
- 07-27 B044：周六/周日自动停发，周一严格只汇总上海日期的周六/周日新闻；HN/X 周一源侧回看 72h 后由终态日期门剔除周五/周一，GitHub 当前榜单不进周一合辑；Digg 429/5xx 增加一次受控恢复。

## 7. 执行队列（黄仁勋自主推进）
1. P0 八路源（#20-27）+ 质量四层 + 两段式深读 → 德彪 review
   - **07-05 批次 1 已落**：#20 ai-hot / #21 v2ex-hot / #24 techmeme / #25 google-ai-blog / #26 qwen-blog / #27 github 月榜（自适应板块标题+月份门）+ items.jsonl F029 证据底料；151/151 测试绿
   - **07-05 批次 2 已落（P0 八路全通）**：#22 reddit-shreddit（限速件抽 `sources/pacing.ts` 共用 + 真实赞数 snippet + per-sub 隔离）/ #23 digg-ai（RSC 跨分片拼接 + 平衡扫描提取 storiesByFilter，schema 07-05 实拍锁 fixture）；真网 smoke **25/25 全绿**（reddit 36 条走代理 / digg 15 条），164/164 测试
   - **07-05 批次 3 已落（质量四层 + 深读全通）**：3a=engagement 贯穿管线（构造层过滤无效值/diversify 互动量优先）+ 刊头体检行；3b=alsoItemIds 跨源合并（护栏：幽灵/自引/重复丢弃截 4）+「N 源同报」徽章 + 全局 usedIds 去重 + 两段式深读（smol-ai contentMode:digest → 抓正文 extractMainText ≤12k → 第二段 LLM 产 titleZh+summaryZh，渲染层覆盖展示、链接仍走 canonicalUrl；全链 fail-open）；173/173 测试
2. 改版五条（小孙 07-05 拍）+ 后置件前提
   - **07-05 批次 4 已落（邮件改版，commit `5895cd0`）**：标签层（pick.tag LLM 白名单打标：ai=推理/OpenAI/Anthropic/Google/Meta/国产/开源/研究/其他，hot=科技/财经/社会/民生/体育/娱乐/国际/其他；X 走 `x-handle-groups` 33 账号静态映射 15 机构/18 从业者，清单外落「更多动态」）+ GitHub 增长榜(日)每天出（stars today 解析，`githubDailySources`）+ 邮件分组渲染（子栏小金标+细线，单组回落扁平；奇数组最长条整宽收长文+估高配对+窄卡摘要 clamp 80——治长短块）+ GitHub 每榜种一张行式榜单卡 + X 喂样按作者轮转；189/189
   - **07-05 批次 5 已落（网页版真可点分栏）**：shared `digest-tags` 真相源（api 邮件子栏 + web tabs 同源）；归档新增 `summary.json`（picks/tags/深读/源健康/计数）；只读端点 `/api/daily-digest/dates`+`/:date`（日期形状守卫防遍历+labels 随包下发）；web `/digest`+`/digest/[date]` 全量 tabs + 每板块「全部抓取条目」折叠 + 信源异常卡 + 体检行（DESIGN.md token 零裸 hex）；邮件可选「网页版 →」链接（`MULTI_AGENT_DIGEST_WEB_BASE`）；真浏览器三交互截图验证；194/194
   - **07-05 批次 6 已落（#31 小红书前提）**：见 §0 #31 行状态；SafeHttpClient 最小扩展 method/body（校验链一条不动，POST 仅 MCP 消费）；206/206
3. ~~设置页（§5）~~ **✅ 07-05 已落**（`9aff853` 后端 + `75e7ff4` 前端 + `61405d8` 德彪修；详见 §5 落地注记；真浏览器保存/400/恢复默认/补发状态机全冒烟）
4. ~~P1 三项（#28-30）~~ **✅/❌ 07-05 收口**（#28/#30 落地 `6a93299`；#29 活探判死降 P2，证据见 P1 表）
5. P2 等待项 **07-10 小孙逐项重拍收口**：#29 判死维持 / **#31 转 F029 当 UGC 核查源**（日报休眠，设计输入 §8）/ #32 **收档**（「B站可以不用了」）/ #33、#34 **开工**（「现在搞」：ffmpeg+Groq key 两步已派，代码批次=合并后第一批）/ #35 **收档**（建议砍，小孙「听你的」）
6. 德彪 review 台账（07-05 晚两批 + 07-06 增量，**全 GO 收口**）：批次 A（8e9d4bb..a9498d3）r1 NO-GO（2P1 LLM 畸形 JSON 炸穿降级链 + 3P2）→ 修 `72349e9` → **r2 GO 零 findings**；批次 B（5895cd0..75e7ff4）r1 NO-GO（3P1 收件人闭环 + 1P2 段清写窗）→ 修 `61405d8` + P1 扩源批 `6a93299` 一并复审 → **r2 GO 零 findings**（.env 种子路径人工件口径他认可不列 blocker）；07-06 首跑纠偏 `26eba5d`（健康空≠失败，keepIf 全滤误报 failed 共性雷）→ **r3 GO**（1P2 旧契约注释 → `98fb7e9` 同步「坏源抛错/[]=健康空」）。至此 F037 全部实现 commit 均过德彪审
7. 07-06 凌晨第二封真发（00:23，86KB，双收件人）：X 覆盖率定案=33 账号零失败仅 5 人发推（官方号低频常态，非 bug）；周一 GitHub 周榜+新秀自动上场（时间切换器首真跑）；YouTube 4/6 频道出条；HN 富化 0 命中=周日凌晨 hn-ai 仅 kept 1 条被跨源去重让位（诊断活体 3/3 通，虚警）；华为邮箱收不到=我方链路无责（QQ 已接收 message-id）卡华为入站网关，小孙三步排查中
7. 当日真发信：07-05 18:31 双收件人（gmail + **新配华为邮箱** sundengjun1@huawei.com，多收件人 AC10 现成）全 LLM 版 77KB，0 源失败，深读首次真跑（1 条）；X 33 账号仅 6 账号出条目——修复批 `72349e9` 起部分失败上日志，明早首封可观测
8. **07-07 批次 D（小孙 07-06 看信反馈六件套，commit `46e6a00`）**：①社区动态改版 x→community（Reddit/Digg/V2EX/小红书归位，X 子组+平台子组，shared digest-tags 真相源，旧归档读取侧 `normalizeDigestCategory` 归一）②中文化补全 `translateExtras`（github desc+速览标题一次批翻，CJK 预滤/sanitize 护栏/fail-open 英文直出；map 进 summary.json 邮件网页共用，job 二次渲染）③月榜常驻（每月 1 号门拆除）④#39/#40 vLLM(Ascend) releases 源 ⑤版式标题层级（板块 24px+通栏底线；子栏实体章节条）⑥简报型源未精选不进速览（"not much happened today" 直出治绝）。281 digest 专项+13 web vitest+tsc 双零+pre-commit 全量绿；07-07 当日信两封：00:00 旧版 `2853e0cf`（小孙报没收到 07-06 信，账本核实 SMTP 已受理属投递侧问题）+ 改版后 force 补发新版（账本见 outbound-ledger 尾行）。德彪批次 D：**r1 NO-GO**（1P1=Reddit/Digg 只改了源 metadata、buildNormalizedItem item 级 category 仍写死 ai——orchestrator 只认 item 自带值，社区归位在真数据里不生效；2P2=LLM 文本进 md/text 面无控制字符/链接结构防护、gh desc 字符串回拼可污染 delimiter parser）→ 修 `bbe3f93`（community+一致性契约断言/sanitizeText 剥控制字符+mdLink 转义/descZh 结构化携带删 withZhDesc）→ **r2 被 codex 配额墙挡**（usage limit，07-09 18:12 解锁；桂芬地区墙仍不可用）——按「禁 silent 代审」家规如实挂起，解锁后补派 r2 回签。**教训：改源板块要改到 item 级 category，metadata 与 item 是两条线**。07-07 第三封（00:36）是并发事故清单版——我误判首个发送任务失败又起了一份，双管线抢 LLM 双双超时降级；修后 v3 单管线重发
9. **07-07 批次 E（小孙 07-07 看信七问，commit `a48901d`）——内容治理**：①**跨日重复根治**（问2）：7 天新鲜窗（漏斗对账实锤：07-07 与 07-06 重复 2881/3178 条，几乎全是 openai-news 1028/smol-ai 668/hf-blog 472 这类档案型全量 feed 每天整库回流）+ `shown-ledger` 跨日已见账本（喂样∪速览∪精选近 7 天不回流，发送成功才落盘，github 榜豁免；07-05/06/07 三天已按新逻辑回填）；items.jsonl 证据底料仍全量（F029 语义不变）②**政治去除+社区聚焦**（问3/4）：`relevance-filter` 保守词表结构层硬滤（明早模拟 3 条命中全真阳性零误杀：俄乌军事/菲弹劾/Trump 转推；AI 监管/芯片出口管制类产业政策**刻意不进词表**）+ summarizer 规则 7 语义红线；v2ex keepIf 科技词表；community 提示词收紧宁缺勿滥 ③**GitHub 四榜常驻**（问5）：周榜+新秀拆周一门（trending 周/月榜是滚动窗口非周界快照）；跨榜同 repo orchestrator dedupeKey 已天然合并 ④**Gmail 102KB 线量错尺子根治**：v4 邮件 98K 字符实为 **104KB 字节已超线被 Gmail 裁尾**（中文化后每汉字 UTF-8 3 字节，旧守卫用 .length）——改字节口径 + 超 96KB 预算自动降速览密度阶梯（12→8→5→3→0）重渲染 ⑤`selectFeedItems` 导出（账本与 prompt 喂样同源防漂移）。测试 283→299 全绿 tsc 双零；明早模拟：3147→252 条（新鲜窗 2807/政治 3/已见 85），ai-hot 喂样 1→5 坑（问6 结构性解决）。问1 答案沉淀 §7.5 runbook。**教训：字节预算类守卫必须用 Buffer.byteLength 不能用 .length，CJK 内容 3 倍差距**。**批次 E 首发（v5）降级复盘+修（`6f9a251`）**：Opus 长输出尾部截断（4809 字符缺根括号，两次确定性复现）→ 旧 parse fail-closed 全弃整报清单版 → `repairTruncatedJson` 括号栈补全（三 parser 全接、护栏不豁免、v5 真响应零损失恢复验证）；305 测试。**07-10 德彪 DE 合并审四轮收敛（D GO + E GO）**：r1=D 1P2（mdLink 不折控制字符，外部源 title/url 带换行可断 md 列表行）+E 2P2（shown 落盘在 recordSent 后有 crash 漏记窗口/新秀榜 created_at 会顶掉 daily 项）→ 修 `d7b5634`（mdFold 单闸/写序调换/newcomers publishedAt 恒 null+合同断言）；07-10 首发再降级=**双撞 240s 超时墙** → 360s `5b36cfc` 重发 degraded=false 96KB；r2=D **GO**、E 卡「360s 未同步 scheduler 看门狗 600s」→ `3d03093` 2700s；r3 抓精确账（RSSHub X 路线 540s 漏算，上界 2760s）→ `283123c` **3600s+三入口锁值断言**；r4=**E GO 零 findings**。教训：**改任一腿 LLM 超时必重算 scheduler 看门狗全链账（每层 timeout 是链条约）**；超时演化 120→240→360s（Opus 波动尾部 382s 级）。测试 308+scheduler 21

10. **07-10 晚收口批（小孙四问+五拍）**：①字体可读性提档 `c59966b`（小字全面 +1px/正文灰 #5c5856→#4a4644；手机 Gmail 对 600px 邮件 ~0.65x 整体缩放是 12px 发糊根因；字节影响=0 实测）②release/视频源时效窗 72h→7 天 `feba9d2`（vllm-ascend 07-02 发版、07-07 加源即已出 72h 窗=永久漏报根因；窗口只管多旧算旧，重复由 shown 账本治）③**r-final holistic 终审三轮**（小孙点名前端整体+全链方案；review 覆盖盘点=30 实现 commit 9 批全 GO 零漏审）：r1 NO-GO 4P1+4P2（mdLink 反斜杠先行转义缺失=md 面链接注入 / shown 同日裸覆盖=force 重发丢首发账 / 修复丢节烧账不透出=实际永久漏报 / width:1%+padding 邮件红线 / 网页收录口径漂移 7 倍 / 无日期条目 8 天周期回流→30 天回看 / 网页 data: scheme 门 / 切日 tab 假空态）→ 全修 `5831cf3` → r2 全 CONFIRMED-FIXED+2 新洞（commit 缺家规签名 / repair 省节假阳性）→ `b4b3d32` 签名重写+保守合同 → **r3 GO 零 findings**④X 机构组 +claudeai/claudeDevs `7835270`（RSSHub 双验活；**裸 claude=路人 Claude R Perrin，坑）**；.env 35 号小孙已配⑤源五拍见 P2 段+队列 5；小红书→F029 交接（§8+F029 记忆）。当日 3 封真发（02:53 清单版超时首发→360s 修→03:14 `95317824` 96KB；17:13 `3073d4f8` 97KB 新字体+shown 并集 86→140 活体证）。教训：**多并行 session 高负载下 pre-commit 门内全量测试 3 个 spawn 型集成测试抖红（单跑/手动全量均绿）——带证跳门=四步手动跑绿留证进 commit message**；**历史重写必先建备份分支**（cherry-pick 误参一度把分支指到空壳 commit，30 秒从备份完整恢复）

11. **07-11 #33/#34 转写批（小孙改拍「现在搞」，不等合并；三 commit 各自过完整门）**：①播客速递 `5c3bbd1`——RSSHub xiaoyuzhou 路由 enclosure 直出 xyzcdn 直链（比 Agent-Reach 页面正则抄本更净，四家 feed 07-10 逐家实测）；两文件引擎+源（`podcast-transcribe.ts` 下载白名单/150MB 双保险硬顶/redirect 终点复验→ffmpeg 16kHz mono 32k→STT→提炼消毒 ≤6 行 600 字；`podcast.ts` 7 天窗+单轮 cap 3 集+部分失败容错/全败 throw）；job/renderer/web 三面直渲流仿 github（「有新集才出现」=空节自动消失）；**缓存分层合同=transcript 先落盘、提炼失败下轮只补提炼（STT 配额永不重烧）** ②YouTube 字幕深读 `6dfc64a`——deepRead +fetchContent 钩 + 18K 喂入闸；yt-* 只加 deepRead.sourceIds 不进 deriveDeepReadSourceIds（那是速览排除口径，YouTube 标题有信息量）；ENOENT 记忆化=未装零开销 ③**STT provider 通用化 `7b90541`**——小孙 Groq 注册两轮被地区拦（"does not belong to any organizations"，官方论坛同类 case 全在问访问国家）→ 不死磕切**硅基流动 SenseVoiceSmall（免费档，官方定价页核实 ¥0）**；STT_API_KEY/BASE/MODEL 三变量、段长 5400→3300s（SiliconFlow ≤1h 单文件门，两家通吃）、自定义 BASE 走直连默认 Groq 走代理。人工件：ffmpeg 8.1.2 winget 代装（小孙授权）+ .env 三行代笔（**小孙两次明确授权，单次例外不成先例**）+ yt-dlp 不装也不影响（装了自动激活）。**活体验证=硅谷101 76min 集全链 68 秒**：27,949 字转写+6 要点（嘉宾归属+数字俱全），缓存 `transcripts/77bd748e2de7ecec.json`（合并迁移件清单已含 transcripts/）。测试 313→347。**教训：biome check --write 目录级会把 CRLF 全目录重写成 LF——commit 前必用 `git diff --numstat` 甄别真变化，行尾幻象文件 checkout 恢复，别把 40 文件噪音带进 feature commit**。后记（同日）：小孙「多加一点 AI 影响大的」→ 扩容 `8a20209`（播客 4→8：张小珺/晚点聊/十字路口/乱翻书；YouTube 6→12：Dwarkesh/Yannic/MLST/OpenAI/Anthropic/DeepMind 官方，@Anthropic=路人坑）+ yt-dlp 429 硬化（--sub-langs 通配符收窄 zh-Hans,en + --sleep-subtitles 3；活体=Dwarkesh 883KB vtt 真拉通、parseVttToText 903KB→96,731 字符）+ yt-dlp 2026.07.04 代装（小孙授权）；**两教训：①管道尾 tail 会吞 git commit 真 exit code——后台 commit 禁止 `| tail`，要完整输出落文件 ②门内全量红先手动全量复现定性（本次=并发 codex 审高负载抖红，3928 tests fail 0），别盲修**。**德彪转写批四轮审收敛闭环（07-11 全真 codex，r1 首派容量墙截杀按家规重派）**：r1 NO-GO 11 条（redirect 白名单只验首跳/取消链不通/网页口径缺 podcastItemIds/health 三分法/ffmpeg 逐段 seek 改 segment muxer/段级缓存/yt-dlp 代理 argv 明文/下载改 pipeline 背压/字幕语言字典序错选英文/STT_PROXY 解耦/--no-playlist）→ 修 `8acd214` → r2 NO-GO 6 条（haiku-runner 不吃 signal 三漏口/3h 后验松 55min/percent-decoded 凭证绕脱敏/下载早退不 cancel body/最终 record 写旧段缓存/boot 日志写死 4 家）→ 修 `739d996`（haiku-runner +opts.signal 共享件升级）→ r3 NO-GO 1 条（P2：互为子串凭证短值先替换泄长值后缀）→ 修 `590778f`（脱敏按长度降序）→ **r4 GO 零 findings**（德彪自跑 tsx 注入实验实证：username=foobar/password=foo 输出双 `***` 零泄漏）。收敛 11→6→1→0；审档 `.runtime/reviews/F037-podcast-batch-review-r{1,2,3,4}-request.md` + r4-verdict.md

12. **07-11 晚小孙六问批**（`d7fd5a8` BCC+未成年人防护 / `7257180` 转推二拍改版）：①收件人互不可见=BCC 密送 ②转推初版「直接滤」被二拍打回→保留+如实归属（xHeadline）+落原帖（api retweeted_tweet 直构；rsshub 维持转推 status=登录态自动落原帖）——**教训：内容治理类改动先跟小孙确认产品语义再动手，「过滤」和「归属改写」是两种产品** ③UNSAFE_CONTENT_RE 未成年人防护（政治词表同机制；高置信词保守收录，AI 安全产业新闻不误杀）④haiku=模块名答疑/设置页模型+发送时间已可配（接线核实 boot buildRunOverrides）⑤验证发信 degraded=false：播客 3 集真转写+预滤 3269→389+101KB 压线观察项（picks/X caps 合并后再议）。**德彪三轮审 GO 闭环（3→1→0）**：r1 NO-GO 3P2（diversityKey 只认 `@handle:` 转推挤单队列实测 36 坑剩 8 X 条/retweeted_tweet 错型 String() 产 `[object Object]` 伪链接/英文治理语境词 child abuse·pornography·human trafficking 误杀「AI 检测 CSAM」类产业新闻三例实锤，BCC 确认无旁路）→修 `b30753c`（regex 兼容转推形态/isPlainRecord+asString+handle·id 形态门 fail-closed/治理词移交语义层 `\bporn\b` 词界）→ r2 NO-GO 1P2（轮转回归测试 33<上限 36 不咬人——**波及既有原创版同病历史债**，07-07 上限 30→36 时即失效）→修 `085b31e`（双测 flood→40+红测实证：旧正则回退 fail 1/恢复 43/43/src 零漂移）→ **r3 GO 零 findings**。审档 .runtime/reviews/F037-sixq-review-*。**两教训：①内容治理类改动先确认产品语义（「过滤」vs「归属改写」是两种产品）②轮转/上限类测试数据量必须超 cap 才咬人，cap 调参时既有测试跟着重审**

## 7.5 源失效处置 runbook（小孙 07-07 问 1「源失效会自动补充/解决吗」的定案）

**已有的自动层（对齐 Agent-Reach 的能力，且多一层持久化）**：
1. **多 URL fallback 链**（`urls` 数组）：前一个失败/空自动试下一个——Agent-Reach 的多实例轮换同款。
2. **RSSHub 双实例**：自建 `localhost:1200`（cookie 路线）优先，官方实例 fallback（`rsshubRoute` 机制）。
3. **单源隔离**：任一源挂不影响整报（orchestrator 独立超时 + try/catch）。
4. **连续失败告警（AC8）**：`source-health` 持久化逐日结果，连续 ≥3 天失败 → `pushAlert` 主动告警 + 邮件页脚健康行点名（x-firsthand 还带「小号 cookie 失效 → 重提 auth_token」修复提示）。
5. **坏源≠安静源契约**：fetch 抛错=failed 进告警链；返回 []=健康空不告警（07-06 纠偏 `26eba5d`）。
6. **共享出站瞬断保护（B043）**：source fan-out 由 group-aware 就绪调度器保序收集、默认并发 6，blocked group 留在 pending、不占全局槽；共享同一上游的 source 另有声明式组闸，同 key 在启动前取最小并发/最大间隔，12 个 YouTube feed 固定串行且相隔 1.5 秒，组内等待不消耗 source 预算。每个 source 的 HTTP 自动绑定同一总预算 signal；`http/httpDirect` 若是同一底层 client 则复用 wrapper，保持 fallback 身份去重。单路幂等 feed 与 GitHub 可在整个 source 内共享一次 transport retry；YouTube 用 3 秒退避且仅 `www` 主路可消费 token，主路两次失败或 parser-zero 后都只走一次 `m` 官方备用路。POST、普通多 URL/direct fallback、多账号/多 feed 不逐请求放大。该层处理的是代理/WAN 瞬断，不会把 parser-zero 或安全拒绝伪装成网络恢复。
7. **周末节奏与空壳保护（B044）**：周六/周日 reconcile 在抓源前返回 `skipped_weekend`；周一只发布有日期且上海业务日落在周六/周日的新闻，HN/X 为覆盖周六临时回看 72h，GitHub 当前榜单不抓。最终 publication 若没有经编辑批准的非 GitHub 正文或播客则整期 fail-closed，不允许榜单兜底；Digg 的 canonical GET 对 429/5xx 只重试一次。

**没有也不该有的**：「自动发明新源」。新源要过白名单推导（SSRF 边界）+ 实测活体验证 + 表驱动登记——这是供应链安全边界，Agent-Reach 同样做不到（它的「自动」也只是实例轮换）。

**人工处置动线（告警响起后）**：症状（页脚健康行/告警消息）→ 查 `.runtime/daily-digest/health/<date>.json` 定位错误 → ① URL 失效：找同源新端点更新 `registry.ts` 该行 → ② 凭证失效（X cookie）：按页脚提示重提 token → ③ 结构变化（digg RSC 类脆源）：更新解析器/锁新 fixture → ④ 彻底死亡：本表该行标 ❌ 带尸检结论（先例 #29 linkedin），候补源从「评估过不进」表复活或走新源评审。

## 8. F029 复用地图（小孙 07-05：「我们这个 feature 的源对 F029 很重要」，F037 做完再推 F029）

F029 = 事实核查 + 深度研究 + 信源溯源综合 feature。复用原则：**F029 直接 import daily-digest 模块（同在 packages/api 内），F037 零改动**；抽共享包等 F029 真用起来再做（YAGNI，避免 F037 返工重审）。

**直接复用件（F037 现成）**
| 模块 | F029 用途 | 备注 |
|---|---|---|
| `safe-http-client` | 抓「声明里引用的任意 URL」——SSRF 威胁模型完全同款（host 白名单/IANA IP 段/逐跳 redirect 重校验/大小超时帽/代理） | F029 是开放网页核查 → 需加一个 `openWeb` 策略选项（放行任意公网 host、仍挡私网/端口/redirect 花活），小改非现在做 |
| `feed-parsers` + `NormalizedItem` | RSS/Atom 解析、URL 归一 `dedupeKey`、统一条目合同 | 溯源的「同一事实多处出现」判定直接用 dedupeKey |
| `sources/registry` 表驱动 + `orchestrator` + `source-health` | 单源隔离/超时预算/跨源去重/连续失败健康——核查任务的批量取证跑批 | timeoutBudgetMs 已支持长跑源 |
| `x-provider`（RSSHub cookie 路线 + 限速） | 「某人是否真发过这条推」第一手取证 | ⚠️ 与日报共享同一小号 cookie：F029 也打 twitter 路由时必须复用同一套 pacing 纪律，两边流量叠加才是真实风控面 |
| 两段式深读正文提取器（P0 批次 3 落地后） | 读证据页原文喂 LLM | |
| LLM runner 家族（`createClaudeModelRunner` + fallback 链） | 已在 runtime/ 共享 | |
| **items.jsonl 日证据底料（07-05 已实现）** | `.runtime/daily-digest/<date>/items.jsonl` 每日全量归一条目 → F029 回溯「X 日各源说了什么」零重抓、零改动 | 随日报天然增长的历史语料库 |

**F029 按需检索件** = 上面「评估过不进」里全部 🔎 项（日报不推送、核查时逐声明调用），接入端点/参数已在本文档 §1 + last30days 调研报告备案。

**07-10 新增定向复用件：小红书 = UGC 口碑核查源（小孙拍「F037 用不到，F029 用得上」，#31 转投）**
- 资产：`sources/xiaohongshu.ts`（MCP tools/call search_feeds + SSE/JSON 双信封 + xsec_token 进链接 + 频控 2.5s±1s，德彪已审）——F029 接入时**提炼共用件**（跨 feature 直 import daily-digest 不干净）
- 证据档位：**UGC 口碑 = 对抗性源（软文/水军密度高），单源不定案**——进交叉矩阵作佐证 + 法证卡 scope 注明档位；恰好复用 F029 既有 capabilities 能力边界机制，零新发明
- 派发判据：消费体验/国内实况/口碑类 claim 才派小红书核查员；技术断言/数字事实/英文向不派（管线 4min/15-25 次 LLM，别浪费在不对口源）——同时补 F029「provider 全英文向」缺口的中文证据腿
- 激活件（F029 接入时做，勿提前常驻）：xiaohongshu-mcp releases 双 exe（`xiaohongshu-login-windows-amd64.exe` 小号扫码 → `xiaohongshu-mcp-windows-amd64.exe` 服务 :18060，首跑自动下 ~150MB 无头浏览器）；env 建议 F029 侧用非 DIGEST 前缀共用名。已同步 F029 记忆「待接输入」段（07-10）

**对 F029 的影响评估**：正面为主（源基建/安全出站/溯源合同全现成）；两个注意点——① 出站白名单是按日报源推导的，F029 要么自己 `deriveOutboundAllowlist` 一套、要么走 openWeb 策略；② digest 型源深读产出的 titleZh 是 LLM 重写标题，F029 引用时必须回 canonicalUrl 原文，不能拿重写标题当证据原文。
