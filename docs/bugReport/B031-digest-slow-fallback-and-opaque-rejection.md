---
id: B031
title: F037 慢模型被内部超时终止且摘要拒绝原因不可观测
status: verification
reported_by: 小孙
reported_at: 2026-07-14
related: F037
---

# B031 — F037 慢模型被内部超时终止且摘要拒绝原因不可观测

## 诊断胶囊

| # | 栏位 | 内容 |
|---|---|---|
| 1 | **Bug 现象** | B030 隔离全链预检中 43/43 源健康、三份播客均由 `gpt-5.6-sol/high` 成功提炼，但主摘要四轮仍为 `failed_summarize`：第 1/2/4 轮收到完整响应后被 strict parser 拒绝，第 3 轮在恰好 360 秒时由本地 runner 主动超时终止，最终没有日报产物。 |
| 2 | **证据** | 首轮隔离预检候选 3227→398；四轮 Codex 响应长度依次为 17846、20679、超时、21131，第三轮恰在 360s 终止。`summarizer.ts` 的单次默认超时被三层 runner 原样复用；scheduler 的 7200s 预算仍按两层模型计算，加入第三层后真实旧账已达 8130s。日志仅写 `parse failed` 与响应尾部，未输出内存中已有的安全定点纠错。修正观测后的第二次预检首稿明确指出 6 个被引用条目经结构复核为 rejected，第二稿移除/修正后通过。 |
| 3 | **假设** | 已证实 H1：统一 360s 会误杀慢 Codex。已证实 H2：第 1/2/4 轮属于 strict editorial contract 失败而非简单截断；新预检的同类首稿具体为 6 个引用在 `applyEditorialPolicy` 后变成 rejected。已证实 H3：两层 watchdog 公式漏算第三层，7200s 小于三层旧最坏账 8130s。strict parser 正确拦截，无需放宽。 |
| 4 | **诊断策略** | 已完成：静态追踪调用级 timeout、AbortSignal 与 scheduler watchdog；先以 4 个失败测试锁定 provider 超时、总预算和安全诊断，再做最小修复。parse-fail 日志只记录固定规则和内部 ID，不再记录响应尾部；用同一隔离全链重跑验证反馈可驱动第二稿通过。 |
| 5 | **超时策略** | 按小孙 07-14“慢本身不算失败、只要能出日报”的决策，旧 30min/2h 仍属于会误切正常慢模型的本地硬上限，继续放宽为极宽挂死保险丝：Claude 6h/层、Codex/high 12h/层，任何调用方小值都不得缩短；播客下载/ffmpeg 各 30min、STT 1h/段、三集整源 96h；三个 scheduler 入口 14d。保守按外层保险丝计，全任务最坏 864750s（10d12m30s），仍留约 3d23h47m30s。 |
| 6 | **预警策略** | 若解决需要降低 strict parser、绕过编辑审核、修改 `.env`/运行时配置、重启服务或先发未验收日报，立即停止并告知小孙。若新的最坏预算超过 scheduler watchdog，也必须先修正预算再运行。 |
| 7 | **用户可见修正** | 已向小孙明确：第三轮是我们自己的 360 秒超时，不是模型报错；首稿审核不通过则是 6 个 policy-rejected 引用，二者互不混淆。现所有日报 LLM 路径（含播客）至少为 Claude 6h/层、Codex/high 12h/层，播客整源 96h、整份日报看门狗 14d；正常响应不会等到上限，这些值只防永久挂死。邮件版式、栏目名与内容门禁均未改变。 |
| 8 | **复现验收** | 第一批 RED 4 项按预期失败、GREEN 定向 90/90。首次 guardian 又发现 provider 原始 stderr 可经 `error` 绕过 strict diagnostic 进入日志，判 BLOCKED；新增 prompt/标题/URL/响应正文哨兵双 RED 后，以安全错误闭集修复。timeout 专项再抓到播客 120s/900s 外层截断并修复。Guardian R3 曾 PASS；随后备用 peer review 抓到配置拓扑可折叠、Windows Claude 只杀壳、社区 pick 过信模型、`mcp` 缩写碰撞 2P1+2P2，已各自 RED→GREEN（58/58、扩展定向 310/310）。因代码继续变化，R3 结论已失效，正式补发仍须新 guardian 与复审放行。 |
| 9 | **Guardian R4** | R4 独立反例证明“AI 实体 + 描述性”仍会放过被模型伪标为 `discussion + agent` 的个人 offer 征询、加班薪资抱怨和 ChatGPT 相亲闲聊，判 `BLOCKED`。三条 publication 反例先以 6/7 RED 稳定复现；最终门复用社区标题性质规则后 7/7，邻接四文件 59/59，真实 vLLM/SGLang 推理讨论继续发布。旧 R4 结论不冒充修复后验收，仍须 R5。 |
| 10 | **备用复审 P1** | R5 后备用 reviewer 进一步复现：把个人性质藏进 `rawSnippet`，或写成较长的 GPT/vLLM 纯赞叹句，仍可借“字数 + AI/技术词”穿透。新增原症状 RED 后，最终门同时检查高置信正文性质，并要求技术/实体信号还必须伴随发布事件、事实动作或技术细节；GPT/vLLM 纯 reaction 均拒绝，vLLM/SGLang 调度讨论、Blender MCP 构建案例和相亲推荐模型 A/B 研究均保留。代码变化后须新 guardian 与复审。 |
| 11 | **Guardian R6** | R6 以零上下文终态探针判 `BLOCKED`：CUDA 故障复盘虽通过前置噪声分类器，却因 publication 不识别“排查/定位/batching/竞态”而被降为 `low_signal`。同一 production-path 用例先 7/8 RED，最小补入诊断动作与竞态细节后 8/8 GREEN，社区邻接 62/62、全量 API 4633/4635（0 FAIL）。R6 结论保持 BLOCKED，修复后必须新开 R7。 |

## Bug Report 六件套

1. **报告人**：小孙；在 B030 预检连续失败后追问审核原因，并明确“时限能放得很宽，只要能出来日报”。
2. **Bug 现象**：固定第三层 Codex 已能运行，但主摘要第三轮被本地 360s 主动终止；其余完整响应被 strict parser 拒绝时只有 `parse failed` 和响应尾段，既无法说明违反哪条规则，也把正文片段写进日志。旧 scheduler 看门狗还漏算了新第三层。
3. **复现步骤**：使用隔离根目录、mock sender 跑完整 reconcile；两层 Claude 因组织权限失败后由 Codex/high 生成摘要。观察第 3 轮在 360s 返回 timeout，第 1/2/4 轮只留下模糊 parse-fail，最终 `failed_summarize`、无归档/邮件。
4. **根因分析**：B030 runner 把同一 `runOptions.timeoutMs` 原样传给所有 provider，Claude 实测校准的 360s 被错误当成 Codex/high 的统一上限；scheduler 测试公式仍硬编码 `2 * DEFAULT_TIMEOUT_MS`。同时 B029 已计算安全 retry feedback，却没有把它记录，反而记录原始响应 tail。观测修复后的真实首稿证明 strict 拒绝源于 6 个引用经结构规则复核为 rejected；parser 行为正确。
5. **修复方案**：`DIGEST_CLAUDE_TIMEOUT_MS=21600000`、`DIGEST_CODEX_TIMEOUT_MS=43200000`，两类 provider 均使用 `max(调用方时限, 保险丝)`，signal 原样贯通。摘要、深读、翻译与播客提炼共用该预算；播客下载/ffmpeg/STT 分别放宽为 30min/30min/1h，整源 96h；全链预算重算为 864750s，三个 scheduler 入口改为 1209600s（14d）。parse-fail 日志仍只记录固定规则+内部 ID 的 `strictDiagnostic`，provider 错误仍归一为安全闭集。不改 parser、prompt 质量门禁或邮件呈现。
6. **验证方式**：provider timeout、调用方更宽不缩短、安全诊断不泄漏正文、watchdog 锁值/关系四项 RED→GREEN；首次 guardian 发现 stderr 旁路后，新增含 prompt/标题/URL/响应正文哨兵的 model 聚合与 summarizer 日志双 RED，修复后定向 92/92。第二次完整隔离预检首稿诊断 6 个 rejected 引用、第二稿修正通过，最终 43/43、`degraded=false`、归档/mock 邮件齐全。全量 API、903 个组件测试、typecheck/build/lint 与 F037 真浏览器 2/2 通过；独立成品内容审计 PASS。

## 设计边界

- 6h/12h 是单次 provider 调用的最终挂死保险丝，不是交付时长目标；调用方给得更宽仍原样保留，给得更窄则不能覆盖它。
- scheduler runtime 的 AbortSignal 尚未传入 digest reconcile；当前到点只会记 timeout、真实任务可能继续成为 ghost。为避免慢模型被假标失败，14d 看门狗严格高于 10d12m30s 保守最坏账。信号贯通与跨入口排队计时属于既有 scheduler 架构债，本批不贸然扩大。

## Review 反馈与修复（2026-07-14）

- 指定的 Claude Opus 4.8 review 因组织禁用 Claude Code subscription 且环境无 Anthropic/Bedrock/Vertex/Foundry 凭据而无法执行；网页通道又被 Cloudflare 人工安全验证拦截。该事实不以其他 reviewer 冒充。
- 备用零上下文 review 判 `BLOCKED`：
  1. `primaryModel/fallbackModel` 可填固定 Codex slug，令三层链折成单层 Codex；
  2. Windows Claude shell fallback 超时/取消只 `proc.kill()`，可能留下真实子进程；
  3. community pick/card 可凭错误的模型 assessment 把纯 reaction 包装成工程摘要；
  4. GitHub topic `mcp` 可把 Minecraft Coder Pack 误当 Model Context Protocol。
- VERIFY：四类反例均以测试稳定复现；修复前目标集 58 项为 53 PASS / 5 FAIL，另一个 `mcp` 反例单测独立 RED。
- FIX：两个设置位只接受 Claude，历史脏值回落默认 Claude 层；Windows Claude 与 Codex 一样按 PID 终止进程树；community publication 以原始 title+snippet 做确定性实质门，不采信生成摘要自证；`mcp` 降为需 description/README 消歧的弱信号。
- GREEN：目标 58/58、扩展定向 310/310、typecheck 与 targeted Biome 通过；榜单排名、四组、跨日状态和邮件版式未变。需新 guardian 与复审确认。
- Guardian R4 继续判 `BLOCKED`：纯 reaction 已封住，但“刚毕业两个 AI offer 大家会选哪个”“大模型应用每天加班、工资不如同学”“ChatGPT 规划相亲路线后独自吃火锅”仍可凭伪造的 `eligible/discussion/agent` 进入 publication。
- VERIFY/RED：精确 publication 反例修复前 6/7，实际发布列表含上述三条；问题属于社区最终准入合同，不是 timeout，也不涉及榜单或邮件布局。
- FIX：`applyEditorialPolicy` 在最终 publication 再复用只扫原始标题的社区性质门；新增高置信“个人职业处境 + 面向社区选项征询”及“加班/工资/同辈比较”组合词，不把生成摘要当证据。
- GREEN：publication 7/7、相邻 relevance/editorial/publication/job 59/59、typecheck 与 targeted Biome PASS；真实 vLLM/SGLang 长上下文推理讨论作为正例保留。修复后仍须全新 Guardian R5 与 reviewer 放行。
- 备用复审继续判 P1：中性标题可把个人噪声藏入 `rawSnippet`，较长 GPT/vLLM 纯赞叹也可借字数穿透；另指出过宽生活/加班词会误杀真实算法评测与 CUDA 故障复盘。
- VERIFY/RED：正文职业征询、加班薪资抱怨、ChatGPT 生活叙事、GPT 长 reaction、vLLM 长 reaction 均以生产 publication 路径复现；技术正例同时锁住。
- FIX/GREEN：标题宽门与正文高置信门分开；正文只在成对个人叙事证据下硬拒绝；实质准入要求 AI/技术信号再配事件、事实动作或技术细节。目标反例全部拒绝，vLLM/SGLang、Blender MCP 与生活领域的模型 A/B 研究保留。
- Guardian R6 仍判 `BLOCKED`：此前 CUDA 正例只覆盖前置噪声谓词，终态 publication 未识别“排查/定位/诊断/debug/investigate”事实动作和 batching/竞态技术细节。
- VERIFY/RED→GREEN：把 CUDA 故障复盘加入与五类反例、其余三类正例相同的 `buildDigestPublication` production-path 用例，修复前精确 7/8，最小补词后 8/8；社区邻接 62/62、全量 API 4633/4635（0 FAIL）、typecheck 与 targeted Biome PASS。R6 不原地改判，等待全新 R7。
