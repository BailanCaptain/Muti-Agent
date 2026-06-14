---
id: F030
title: Rich Blocks 只读卡片协议（C1）
status: done
owner: 黄仁勋
created: 2026-06-13
completed: 2026-06-14
---

# F030 — Rich Blocks 只读卡片协议（C1）

> clowder-ai 借鉴批次（F030-F035）第 1 个。调研对照 + 德彪 codex 讨论一轮定边界，小孙拍"界面体验优先"。
> 参考实现：`C:\Users\-\Desktop\cafe-multi-agent\clowder-ai`（docs/features/F022-rich-blocks.md、F096、cat-cafe-skills/rich-messaging/SKILL.md）。

## Why

review 结论、AC 清单、evidence 摘要现在全是长 Markdown 砌墙，小孙在长 thread 里要自己挖关键状态（"过没过？几个 P1？"）。clowder-ai 的声明式卡片协议验证了：agent 发一段小 JSON → 前端渲染成带语义色的结构化卡片，扫一眼即得状态。

我们已有雏形（F012 引入 `lib/blocks.ts` CardBlock/DiffBlock + `block-renderer.tsx`），但**缺 agent 侧的发送协议和使用指引**——卡片能力存在，三个 agent 却从不发。本 feature 是接线 + 扩展，不是新建。

## What

agent 可声明式发送只读卡片，小孙感知：review 结论变成绿/黄/红卡片、AC 清单变成 checklist 视图。

- card kind 升级：tone（info/success/warning/danger）+ fields 键值对
- 新增 checklist kind
- agent → 前端的发送通道 + 入口强校验（非法 block fail-closed 降级纯文本）
- 防粘连：block 绑定消息/invocation，invocation 完成后迟到 block 拒绝
- rich-messaging skill：教三 agent 何时发/怎么发（先文字后块、不确定就纯文本）

## Acceptance Criteria

- [x] AC1: CardBlock 支持 tone + fields，渲染组件按 tone 着色；现有 card 消费方不回归
- [x] AC2: 新增 ChecklistBlock kind + 渲染组件（含勾选状态只读显示）
- [x] AC3: agent 发卡片通道落地（MCP 工具 / 内联围栏，Design Gate 定）+ Zod discriminatedUnion 入口校验，非法 block 降级纯文本不崩渲染
- [x] AC4: block 与消息/invocation 绑定 + 去重 + invocation 完成后拒迟到块（防挂错气泡，clowder F096 B4 教训）——通道拍板后"迟到块"按构造不可能，绑定/去重/半截围栏测试锁定
- [x] AC5: rich-messaging skill 写好 + manifest 注册 + 三 agent 挂载 + check:skills 过
- [x] AC6: dogfood——一次真实 review 结论以卡片发出，小孙确认可读性提升（卡片已真发：preview :3103 dogfood 会话，截图 .agents/acceptance/F030/2026-06-13-overnight/ac6-dogfood-cards.png；**2026-06-14 小孙验收通过："可以 没啥问题"——卡片可读性 OK + 折叠态/侧栏摘要无 cc_rich/JSON 泄漏**）

## Dependencies

- 无硬依赖（现有 Block 体系 F012 已就绪）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 发送通道 | MCP 工具 vs 消息内联围栏（cc_rich 式） | **内联 cc_rich 围栏单轨**（MCP 轨推迟 F033） | 我们 runtime 的 final assistant 消息自动持久化 + post_message post-final lockout（mcp/server.ts:304-311）——review 结论恰是 final 消息，MCP 推送轨够不着 AC6 场景；内联围栏 final/progress/a2a 全覆盖，历史回放免费获得 |
| 解析位置 | 后端持久化层 vs 前端 normalize 层 | 前端 `normalizeMessageToBlocks`（assistant 消息 only） | DB content 原样持久化（FTS/recall 不受影响），主渲染在前端 normalize 层；未闭合 cc_rich 隐藏不显原文（r3 AC6），闭合转卡片，闭合非法 fail-closed——详见下方行为矩阵 |
| AC4 迟到块 | 运行时拒收 vs 按构造不可能 | **按构造不可能** + 测试锁定 | 单轨内联通道下块内嵌消息体，无异步 attach 路径（clowder F096 B4 的病灶是推送通道）；绑定/去重/半截围栏均有单测 |
| Zod schema 位置 | 前端 lib vs packages/shared | `packages/shared/src/rich-blocks.ts` | F033 交互卡片后端校验复用同一 schema，单一真相源 |
| 范围边界 | 是否含 interactive | 否，只读；交互归 F033 | 德彪建议拆读写，独立交付 |
| 后端预期 | "零后端改动"？ | 本期实际后端改动 = shared schema + zod 依赖 + r3 P2 的 session-service 预览清理（`stripRichFencesForPreview`）；无持久化/DB 改动 | 通道拍板后"MCP/持久化后端件"推迟 F033 |

### 围栏行为矩阵（r8/r9 定稿 · 单一真相源）

**两个层职责不同，别混淆**：
- **主渲染** `parseRichSegments`：消息正文 → 卡片/markdown 段（解析+校验 JSON）。围栏检测行首锚定 `^ {0,3}`。
- **展示摘要** `stripRichFencesForPreview`：折叠态/侧栏/session-group/bootstrap 的 last-message 预览。使命唯一——**别让原始 JSON 漏进摘要**，故**不解析/不校验 JSON、所有围栏一律折叠**（cc_rich→`[卡片]`、普通→`[代码块]`、未闭合 cc_rich→隐藏）。

| cc_rich 围栏状态 | 主渲染 `parseRichSegments` | 展示摘要 `stripRichFencesForPreview` |
|---|---|---|
| **未闭合** | **隐藏**（前导留——AC6 不看黑框） | **隐藏**（前导留） |
| 闭合 + 合法 | 出 card/checklist | `[卡片]` 占位 |
| 闭合 + JSON 非法/超限/重复 | **fail-closed 显原文/去重** | `[卡片]` 占位（不校验，绝不露 JSON） |
| **普通代码围栏**（非 cc_rich，含内部 cc_rich 示例行） | 保留为代码块（不出卡片） | **`[代码块]` 折叠**（r7 always-fold：原样保留会让四反引号/```text 包的内层 JSON 漏侧栏） |

**行模型与 main 对齐（r8）**：摘要层 `split("\n")` 与 main 完全一致，**不再 split U+2028/U+2029/U+0085/lone-CR**。这些字符在合法 JSON 字符串里合法、main 当单行整体 parse 成卡片；preview 若多切一行就会在卡片 JSON 体内把内嵌 ``` 当早闭栏、漏 JSON 尾（"main 卡片化 / preview 泄漏"的反向不对称，dual-oracle 复现，与德彪 r7-P2 同源）。`\r`/`\n` 不可能出现在合法 JSON 串内（非法控制字符 → main 必 parse 失败显原文），故只 split `\n` 与 main 对称。

**容器感知（r6→r7 保留）**：摘要层**开栏**先 `deprefixForFenceScan` 剥容器前缀（`[\s\p{Cf}]` 含 NBSP/Tab/ZWSP/WJ/LRM/RLM/U+180E + blockquote `>` + list 标记，循环）+ isRich 首词忽略大小写，故能折叠 blockquote/嵌套/list/缩进/不可见字符前缀里的围栏（行首锚定的 main 认不出、main 气泡显原文 → preview 折叠是 over-fold，对称安全）。**闭栏**用 main 同款 strict（≤3 空格、不剥前缀）。

**权威保护：main cc_rich 区间优先（r8/r9 · 德彪 r8-P2 交叉围栏）**：deprefix 让 preview 能开 main 认不出的**外层围栏**（`> ~~~` / 反向 marker / list 外层），其 strict-close 可能落在 main 某个 cc_rich 区间**内部** → preview 折叠边界与 main 卡片/隐藏区"交叉但非包含" → main 卡片化/隐藏的 JSON 被当区间外正文漏出。**"开栏 deprefix 超集"只覆盖开栏、不足以证明安全。** 故摘要层先用 main 精确语义（行首锚定 + `info===cc_rich`）算出 main 的所有 cc_rich 区间（`mainCcRichRegions`）：preview 扫描一旦落入区间，**直接按 main 处置**（闭合 → `[卡片]` 跳过整段、未闭合 → 隐藏到 EOF），区间外的行 main 必显原文、才走 deprefix-fold。**结构性保证**：preview 唯一的原文输出只发生在 main cc_rich 区间外（main 也显原文）→ 不可能漏 main 卡片化/隐藏的 JSON。

| cc_rich 围栏（**main 顶层**） | 主渲染 `parseRichSegments` | 展示摘要 `stripRichFencesForPreview` |
|---|---|---|
| 未闭合 | 隐藏 [start,EOF] | 隐藏 [start,EOF]（按 main 区间） |
| 闭合（合法/非法/超限） | 卡片 / fail-closed 显原文 | `[卡片]` 占位（按 main 区间，绝不显 JSON） |
| 容器/嵌套包裹（main 认不出） | 当 markdown/代码显原文 | deprefix-fold → `[卡片]`/`[代码块]`（over-fold，对称安全） |

**Out of scope（归 ingest 规范化层，非本函数职责）**：prose/HTML/表格里的裸 JSON、组合字符(Mn)前缀（强剥会破坏重音文字）、mid-marker 不可见字符、整段用 U+2028/U+2029/CRLF 塌行的输入——这些 main 也不出卡片、main 气泡同样透传，属"两侧对称"，preview 不比 main 多漏即满足职责。

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-06-13 | Kickoff（clowder-ai 借鉴批次，德彪讨论意见见 .runtime/reviews/clowder-ai-reference-discussion-request.md） |
| 2026-06-13 | Design Gate 过（小孙看 wireframe 后 go）；通道拍板内联 cc_rich 单轨；Task 0-6 实施完（schema/解析器/normalize/checklist 组件/card 契约测试/skill），plan 见 docs/plans/F030-rich-blocks-readonly-cards-plan.md |
| 2026-06-13 | quality-gate 全绿 + 零上下文 guardian AC1-AC5 PASS；德彪 r1 NEEDS-WORK（3 P2 + 1 P3）→ 修复 4dc96e2（4 红测试先行）→ r2 **GO**（4/4 PASS 无新增）；AC6 dogfood 卡片已真发（preview 真 agent turn，UI 截图留证），待小孙验收 |
| 2026-06-13 | AC6 真人验收：小孙反馈卡片"丑"+流式"黑框"。视觉对齐 decision-card（圆角全框/渐变/tone 图标）；黑框真根因——messageType 实测=`final` 非 `progress`，前两版 `isStreaming` 空修→ **8074c98** 未闭合 cc_rich 一律隐藏（不依赖流式）。德彪 **r3 NEEDS-WORK**（1 P2 摘要面泄漏 + 2 P3）→ 修复：`stripRichFencesForPreview` 4 个展示摘要面复用（折叠/侧栏×2/session-group）+ tone 视觉区分测试 + 本行为矩阵 |
| 2026-06-13 | 德彪 **r4 NEEDS-WORK**（2 P2 + 1 P3）：①漏 `/api/bootstrap` 走的 Drizzle/legacy `listSessionGroups` 预览（第 5/6 个面）②sanitizer 不跟踪普通围栏，四反引号内的 cc_rich 示例被误折叠 ③矩阵把主渲染/摘要两层混谈。→ 修复：两 repo 预览复用 sanitizer + listSessionGroups 回归测试；sanitizer 重写跟踪普通围栏（镜像主解析器）；矩阵改双层（主渲染 fail-closed-visible vs 摘要一律 `[卡片]`）|
| 2026-06-13~14 | **摘要泄漏 r5-r10 深水区**：r5 NW+§17 TAKEOVER（buildFoldedPreview 下游贪婪正则四反引号泄漏，假绿 2 次）→ 小孙 override §17→ r6 NW（删贪婪正则引入 blockquote 容器回归）→ **小孙二次 override + 切 ultracode**（workflow 多 agent 编排补单视角盲点）→ r7 容器/编码穷尽修（c1b9a3f，container-scanner + always-fold）→ r7 NW（false-close 宽松回退漏后文）→ strict-close-for-all（0f707f2）→ **r8 派审前我用 ultracode 自建可执行 dual-oracle + workflow 生成 220 对抗语料自查，抓到自己 2 个反向泄漏**（多分隔符 split 把合法 JSON 卡片体切开早闭栏）→ split 对齐 main `split("\n")`（8dc1e92）→ 德彪 **r8 NW**（交叉围栏：preview-only 外层围栏与 main cc_rich 区间交叉非包含漏）→ **mainCcRichRegions 权威保护**（c826189，preview 落入 main cc_rich 区间即按 main 处置）→ 德彪 **r9 正确性 GO** + 仅 P2 区间查询 O(R²)→ 单调游标 O(lines+regions)（ec59a1d）→ 德彪 **r10 GO ✅ §17 TAKEOVER 关闭**。dual-oracle 370 对抗用例（跨 12 视角生成）0 不对称 defect；门禁 typecheck/build 0、shared 97、摘要面 session 70/70。**待小孙晨间 AC6 + merge** |
| 2026-06-14 | **AC6 小孙验收通过**（"可以 没啥问题"）→ 6/6 AC 全绿。merge-gate：rebase 到本地 dev（ccc7843，merge-tree 0 冲突）→ squash 单 commit → ff-merge → push origin/dev → 清理 worktree。Feature **done** |

## Links

- Related: F012（消息卡片化基础，done）、F020（决策卡片挂载矩阵，spec）、F033（交互卡片，backlog）

## Evolution

- **Evolved from**: F012
- **Blocks**: F033（交互卡片建立在本协议上）
- **Related**: F020
