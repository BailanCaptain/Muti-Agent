---
id: F042
title: 记忆消费闭环（一期）：direct_turn shadow 召回 + 采纳度量 + canonical 生命周期 + 编译候选喂料
status: done
owner: 黄仁勋
created: 2026-07-10
completed: 2026-07-12
---

# F042 — 记忆消费闭环（一期）

## Why

2026-07-10 对 F027 记忆系统做了两轮只读深审（生态层 + 灵魂层）+ 黄仁勋×范德彪双盲对抗对谈，结论：**「越用越聪明」四环（用→攒→提炼→喂回）只有「攒」在转**。四个已核实的生产断点：

1. **主流交互设计性不召回**：`message-service.ts:142` direct_turn → scenario_skip，coordinator 白名单只有 wake_up/a2a_handoff，Hard Gate（`hard-gate.ts:25`）生产 caller=0 —— 用户日常消息永远白板，**F040 IM 入口上线也不会自动带记忆**。
2. **无采纳度量**：prompt_audit 全库 3 行，recall_satisfied 只是 critique 判 hits 覆盖 query，没有「回复用没用上」信号——「越用越聪明」无法被证真或证伪。
3. **canonical 无生命周期**：supersedes 只是描述性 frontmatter（`post-compile.ts:90`），无退出执行器——F031 新旧两版并存正式区且都可被搜到（一版说 spec 一版说 DONE，自相矛盾）；NHC 死链警告 15 条全是 _superseded 归档自噪音。
4. **编译候选恒空**：`ingest-preview.ts:277` 不传 options.pre → threadIds=[] → 相似检索恒跳过；且 searchByVector 搜的是 message_embeddings（领域错位），"wiki-pool" 只活在测试；sources.path 精确身份不进 compile prompt → 58/64 篇编译于正式区空窗期，cross_refs/dedup 盲编。

小孙 07-10 拍板：**手机（F040 IM）+ 网页双入口都会用** → 记忆必须在这两个入口的日常消息上闭环。宿主方向共识 = repo-first、surface-agnostic（wiki = 派生索引 + 审批面；房间/IM/CLI 平等消费面）。

## What

四件活让「喂回」环转起来，小孙可感知的变化：

- 在网页/手机发普通消息时，系统开始做记忆前置查询（**先影子运行**：只记录不注入，攒真实数据）
- 能看到记忆统计：查了多少次、命中什么、回复采纳率多少
- 搜索不再搜出新旧自相矛盾的双版本
- 新收录的知识自动识别同源旧版（替代/合并），开始长出引用关系

## Acceptance Criteria

- [x] **AC1 · direct_turn shadow 召回**：coordinator 触发白名单扩 direct_turn，三态配置 `off|shadow|inject`（默认 shadow）；shadow = 全召回链真跑 + 写 prompt_audit，但不注入 prompt。验收：网页发普通消息 → prompt_audit 新增行（recall_trigger=direct_turn，含 queries/results），该轮 parts 无 recall-pack；开关三态各自生效。
- [x] **AC2 · 采纳度量**：prompt_audit 扩 injected/candidate paths + 采纳判定（回复文本对召回条目的引用启发式）+ 统计接口（窗口内：召回次数 / 命中率 / Top 命中条目 / 采纳率）。schema 变更走 migration。**主动提示两时机（小孙 07-10 追问定）**：①影子观察窗跑满（50 次 direct_turn 召回或 14 天先到为准）→ 主动发一次性小结（命中率/采纳率/Top 条目 + 放开注入与否的建议），走房间消息卡，F040 合并后可推 IM；②攒满 30-50 条标注 → 提示可拍 rerank 立项。无常态推送。验收：真实消息跑批后统计接口返回非零数字，抽 3 条人工核对采纳判定方向正确；模拟窗口满 → 小结消息真发出。
- [x] **AC3 · canonical 生命周期**：promote 时 sources.path 同源精确匹配正式区已有条目 → 强制显式 supersede/merge 选择（复用 dest_exists 对比弹窗模式）；被替代条目退出召回面（entity_index 除名/标记，search_wiki + preflight + adaptive-recall Level 2 同步过滤）；NHC 死链扫描排除 `_superseded`。验收：F031 双胞胎场景重放 —— 收录新版后旧版被显式 supersede 且 search_wiki 搜不到；NHC 报告 0 条 _superseded 噪音。
- [x] **AC4 · 编译候选喂料**：pre-compile 相似检索改接 wiki_entity_index（top-5 真实 score，替代 message_embeddings 误用）；sources[0].path 精确身份进 compile prompt（dedup 确定性信号）。验收：正式区已有同源条目时重放收录 → dedup verdict ≠ new_entity 且给出正确 target；相关条目场景 cross_refs 非空。
- [x] **AC5 · 外部守活（轻）**：进程外健康探针脚本（15-30min 探 /health，失败通知，可标记「手动停用」不误报）+ 安装说明，重启主仓时装。验收：杀 API 后一个周期内报警；维护模式静默。
- [x] **AC6 · direct_turn 召回链路真实可用（快链改造；小孙 07-11 拍「现在修，要做就做好」，黄×德彪方案收敛）**：
  ①**查询编译器**：sanitize 拆安全层（quote/FTS 注入防护，语义不变）与策略层 `compileRecallFtsQuery`（只挂召回链，手动 search_wiki/query_messages 不变）——CJK ≥3 字连续段→去重三字滑窗、token 间 OR；1-2 字段不进 MATCH（trigram 物理死 token，显式不支持）；显式实体信号（F/R/B 编号、wiki path、引号术语）作 MUST clause；clause 去重封顶 32。
  ②**本地 evidence gate 替代同步 LLM critique**：实体/path 精确命中直通；否则 ≥2 不同 clause 命中且 coverage 达 fixture 校准下限；单常见片段命中 reject。禁用 corpus-minmax score 当绝对置信度（best/单 hit 恒 1）。provider 返回命中证据（matchedClauseCount/coverage/exactEntityMatches）。
  ③**direct_turn 专用管道** L2→gate→L3→gate→正常 miss：全程无同步 LLM/embedding（BM25-only lexical）；普通 miss 不写 L5 escalate（防 wiki_events 风暴），只有真 backend failure 记异常；同步链 CLI critique 全部退出（wake_up 同切本地判定），LLM critique 仅保留异步标注/离线校准位。
  ④**excerpt 取命中附近 snippet**（不再无条件 body.slice(0,200)，防「相关 path + 无关正文开头」注入）。
  ⑤**延迟预算覆盖 backend 调用**：p95≤200ms / p99≤500ms / 500ms 到点 fail-open 不注入。
  验收：中文自然问句在 preview 活体召回已存在正确条目（recall_results 非空 + critique_calls=0 + 预算内完成）；OR 噪声负例不注入（具名回归 case）；2 字纯短 query 行为明确定义；普通 miss 零 recall_escalate 行；shadow + inject 两态活体证据；audit 语义/统计测试同步更新。

**Out of scope**（写明触发条件）：rerank 转正（触发 = AC2 攒到 30-50 条真实召回标注后另立项，离散 grade 0-3 + rankScore/gateDecision 分离 + 校准回归门）——AC6 只做 lexical 快链，完整 LLM rerank / jieba 分词 / 新向量召回均不进；viewfinder 语义打磨（触发 = 房间/IM 流量回稳）；CLI preflight wrapper（二期）；F040 connector 本体。

## Dependencies

- **F040 先合并**（软依赖）：同在 message-service 面改动，避免 worktree 冲突；且 IM 入口上线即带 AC1 shadow 召回。
- 复用 F027 存量资产：`hard-gate.ts`（已实现零 caller）、dest_exists 对比弹窗、entity_index reindex 链、prompt_audit 表、embedded records 热加载。

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 宿主方向 | A 等房间复活 / B 接 CLI / C 降级 / D repo-first surface-agnostic | **D**（小孙 07-10 拍双入口） | 记忆跟着工作流走；wiki 降为派生索引+审批面，不承担唯一真相 |
| direct_turn 召回姿态 | 直接注入 / 先影子 | **shadow 默认** | n=3 无数据，先攒「查得准不准」的真实记录再放开注入（德彪） |
| rerank 时机 | 现在修 / 攒数据后 | **押后至 30-50 条标注** | 当前调参是无的放矢；gate 双职责（BM25 命中恒 1.0 直通门）留待彼时一并拆 |
| 杠杆序 | 黄版（rerank 先）/ 德彪版（入口/度量先） | **德彪版**（黄仁勋被说服附议） | 证伪度量先于调参；否则第三次造好机器等流量 |
| 否决项 | — | 图数据库/独立向量库/全 LLM viewfinder/单独等 F040 复活 | 给没人借书的图书馆装豪华电梯 |
| direct_turn 评估层（AC6） | 同步 LLM critique 调快（API 直调）/ 彻底去 LLM | **去 LLM，本地 evidence gate**（黄×德彪 07-11 一致，ADR-005） | 观察窗实证：critique spawn CLI 30s timeout ×2 fallback vs 总预算 5s，100% 熔断——「调快」只把不可能变紧张，这条链上不该有 LLM |
| 中文检索策略（AC6） | jieba 分词新依赖 / trigram 三字滑窗 query compiler | **三字滑窗 OR + 实体 MUST（零新依赖）** | 德彪 SQLite 3.53 内存实测：trigram 表 2 字 query 物理死 token、三字滑窗 OR 命中；切窗与表 tokenizer 对齐即可，无需分词库 |
| miss 终态语义（AC6） | 沿用五级 L5 escalate / direct_turn 正常 miss | **direct_turn miss 不进 L4/L5** | 日常消息 miss 是常态不是异常；每 miss 写 wiki_events = escalate 事件风暴（德彪） |
| inject 开启门槛（AC6） | heuristic 采纳率≥60% 单指标 / 多指标含人工标注 | **多指标**：≥50 settled（网页+IM 双入口）+ ≥30 条人工标注 top-1 precision ≥80% + 严重误召回（旧结论/跨房间污染/矛盾）0 + p95≤200ms；采纳率≥60% 降辅助指标；小孙人工 .env 开闸不变 | shadow 态回复看不到召回结果，「采纳率」是相关性代理非真采纳（德彪实证 adoption-heuristic 假阴性高）；错误记忆注入比不注入更伤「越用越聪明」的信任 |

**Design Gate 已过**：纯后端共识 = 07-10 黄×范双盲对抗对谈（真 Codex xhigh，session `019f49e3`，杠杆表 P0-P5 逐条 file:line 核实）；架构方向 = 小孙拍板（手机+网页都用）。

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-10 | Kickoff（源自 F027 灵魂层审计 + 德彪对谈共识；小孙拍双入口方向） |
| 2026-07-11 | AC1-5 实施+验收+guardian+德彪三轮审+TAKEOVER 全链闭环（15 commits `0c8769f..a9141ae`）；观察窗首批数据照出召回管道三病灶：critique 30s vs 预算 5s 100% 熔断、中文整句 trigram 恒空、恒零命中 |
| 2026-07-11 | 小孙愿景对照打回「没达到 feature 目的」拍「现在修」→ 扩 AC6；黄仁勋诊断（file:line+DB 铁证）×范德彪独立分析收敛（verdict 存 `.runtime/reviews/F042-recall-fix-debiao-verdict.md`）；沉淀 ADR-005 + LL-035/036/037 |
| 2026-07-11 | AC6 实施+活体（Task14-19，`4fd6b52..6d8a68b` 七 commits）：中文自然句 28-60s 恒空→47-86ms 真命中、inject 态 2ms recall-pack 真注入；德彪三轮审 r1 3→r2 3→r3 2 + §17 TAKEOVER（every→some 量词 + 合并 topK）→ 0 未决；guardian 零上下文 PASS |
| 2026-07-12 | 小孙 UI 验收通过（audit #70 命中探针文档 80ms / #69 闲聊真空 76ms）拍「go 往下推进」；验收期环境事故=26h 老 preview API spawn 退化致 [empty response]，重启即愈，召回层全程无恙（AC5 探针价值第二实证）；squash 合 dev |

## AC5 探针安装说明（重启主仓时装）

```
# 安装（当前用户权限，20 分钟一发）
schtasks /create /tn "MultiAgent-HealthProbe" /sc minute /mo 20 /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\-\Desktop\Multi-Agent\scripts\health-probe.ps1"
# 卸载
schtasks /delete /tn "MultiAgent-HealthProbe" /f
# 手动停 runtime 前开维护模式（防误报）；重启后关
powershell -File scripts\health-probe.ps1 -SetMaintenance on
powershell -File scripts\health-probe.ps1 -SetMaintenance off
```

失败报警走 Windows toast（零依赖）+ `.runtime/health-probe.log` 流水；维护 flag = `.runtime/maintenance.flag`。

## Links

- Plan: [F042 实施计划](../plans/F042-memory-consumption-loop-plan.md)（锚点四路核查 @ dev `480d568`，13 tasks TDD）
- Discussion: 对谈纪要与两份审计存 `.runtime/reviews/F027-{vision,soul}-audit-2026-07-10.md` + `F027-soul-discussion-minutes-2026-07-10.md`（scratch 不入库，结论已沉淀本文件）；codex session `019f49e3-3835-7472-9d5d-53bd7244d32c`
- Related: F040（IM 入口）、F027（资产来源）

## Evolution

- **Evolved from**: F027（统一记忆架构——本 feature 是其消费端复活一期）
- **Blocks**: 无
- **Related**: F040（软依赖先合）、F041（预留投研跟踪，未立项）
