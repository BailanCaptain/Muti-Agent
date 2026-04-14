# B012 — SOP 书签阶段漂移导致 seal 后重复劳动

Related: F007

## 1. 报告人

小孙（产品/CVO）在 F007 开发过程中发现。真实场景：F008 立项已走完 kickoff → ROADMAP → 聚合文件 → Design Gate，seal 后 agent 又从头重做；F007 自身也出现 3 次重复确认"已完成并合入 dev"。

## 2. Bug 现象

seal 触发后，agent 重复回答已完成的问题或重跑已完成的流程步骤。SOP 书签持续卡在 `phase=review, next=address feedback`，与实际进度（已 merge 到 dev）严重不符。

## 3. 复现步骤

**期望行为**：seal 触发 → 书签记录真实进度（如 `phase=completed`）→ 新 session 从断点接续  
**实际行为**：seal 触发 → 书签错误记录为 `phase=review` → 新 session 重跑 review 阶段

复现路径：
1. 在任何 skill 流程中持续对话直到 seal 触发
2. agent 输出中包含 "review" / "merge" 等关键词（即使是描述已完成的工作）
3. `extractSOPBookmark` 正则匹配到这些词 → 误判为当前阶段
4. seal 后续接消息带着错误的书签 → agent 从错误阶段开始

## 4. 根因分析（4 个 bug）

### Bug 1：`extractSOPBookmark` 用正则匹配 agent 输出文本，根本不可靠
- **文件**：`sop-bookmark.ts:32-44`
- **证据**：`PHASE_PATTERNS` 遍历 agent 输出匹配 `review|审查|code.?review` 等关键词
- **问题**：agent 说"已完成 review"或"merge 后补 review 测试"，正则也命中 → 误判为 `phase=review`
- **这就是 SOP 书签一直卡在 `writing-plans | phase=review` 的根因**

### Bug 2：`buildAutoResumeMessage` 丢掉了 `lastCompletedStep`
- **文件**：`auto-resume.ts:18-28`
- **证据**：续接消息只包含 `skill/phase/next`，不包含 `lastCompletedStep` 和 `last=...`
- **对比**：`formatBookmarkForInjection`（system prompt 注入）**有** `last=` 字段
- **后果**：agent 知道"下一步是 address feedback"，但不知道"已经完成了什么"，于是从头开始

### Bug 3：bookmark 在 SOP 推进之前提取
- **文件**：`message-service.ts:1123-1124`（提取）vs `message-service.ts:1216`（推进）
- **证据**：`extractSOPBookmark` 在 line 1124，`advanceSopIfNeeded` 在 line 1216
- **问题**：如果这轮 turn SOP 从 `review` 推进到 `merge`，bookmark 记录的仍是旧的 `review`

### Bug 4：`newSessionFillRatio` 写死为 0，安全阀失效
- **文件**：`message-service.ts:1242`
- **证据**：`shouldAutoResume(parsedBookmark, resumeCount, MAX_AUTO_RESUMES, 0)` — 第四个参数硬编码 0
- **问题**：`auto-resume.ts:14` 的 `if (newSessionFillRatio > 0.5) return false` 永远不触发
- **后果**：只要 bookmark 有 `nextExpectedAction`，就会无条件续接

## 5. 修复方案

| Bug | 修复 | 文件 | 理由 |
|-----|------|------|------|
| 1 | 用 `sopTracker.getStage()` 结构化状态替代正则。增加 `phase=completed` — skill 已完成时标记 completed，`shouldAutoResume` 遇到 completed 返回 false | `sop-bookmark.ts` | 正则在自然语言上不可靠，sopTracker 有精确的阶段状态 |
| 2 | `buildAutoResumeMessage` 加入 `last=` 字段，与 `formatBookmarkForInjection` 对齐 | `auto-resume.ts` | agent 需要知道"已完成了什么"才能不重跑 |
| 3 | 把 bookmark 提取移到 `advanceSopIfNeeded()` 之后 | `message-service.ts` | 确保 bookmark 反映推进后的最新阶段 |
| 4 | 传入上一轮真实 `fillRatio`；`shouldAutoResume` 对 `phase=completed` 短路返回 false | `auto-resume.ts`, `message-service.ts` | 安全阀必须生效 |

**放弃的备选**：不考虑"改正则让它更准"——正则在自然语言匹配上是死胡同，再精确的正则也无法区分"我在做 review"和"我已经做完了 review"。

## 6. 验证方式

- Bug 1：测试 `extractSOPBookmark` 在 agent 输出包含 "已完成 review" 时不误判为 `phase=review`
- Bug 2：测试 `buildAutoResumeMessage` 输出包含 `last=` 字段
- Bug 3：验证 bookmark 提取位置在 `advanceSopIfNeeded` 之后（代码审查）
- Bug 4：测试 `shouldAutoResume` 对 `phase=completed` 返回 false；验证 `message-service.ts` 传入真实 fillRatio
- 回归：全量测试套件 + tsc 编译
