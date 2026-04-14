# B012 — SOP 书签阶段漂移导致 seal 后重复劳动

Related: F007

## 1. 报告人

小孙（产品/CVO）在 F007 开发过程中发现。真实场景：F008 立项已走完 kickoff → ROADMAP → 聚合文件 → Design Gate，seal 后 agent 又从头重做；F007 自身也出现 3 次重复确认"已完成并合入 dev"。

## 2. Bug 现象

seal 触发后，agent 重复回答已完成的问题或重跑已完成的流程步骤。SOP 书签持续卡在 `phase=review, next=address feedback`，与实际进度（已 merge 到 dev）严重不符。

## 3. 复现步骤

**期望行为**：seal 触发 → 书签记录真实进度 → 新 session 从断点接续  
**实际行为**：seal 触发 → 书签错误记录为 `phase=review` → 新 session 重跑已完成的工作

复现路径：
1. 在任何 skill 流程中持续对话直到 seal 触发
2. agent 输出中包含 "review" / "merge" 等关键词（即使是描述已完成的工作）
3. `extractSOPBookmark` 正则匹配到这些词 → 误判为当前阶段
4. seal 后续接消息带着错误的书签 → agent 从错误阶段开始

## 4. 根因分析（4 个 bug）

### Bug 1：`extractSOPBookmark` 用正则匹配 agent 输出文本检测 phase，根本不可靠
- **文件**：`sop-bookmark.ts` — `PHASE_PATTERNS` 数组
- **证据**：遍历 agent 输出最后 300 字符匹配 `review|审查|code.?review` 等关键词
- **问题**：agent 说"已完成 review"或"merge 后补 review 测试"，正则也命中 → 误判为 `phase=review`
- **首次修复（a54cd24）为何无效**：添加了 `completed:` 前缀检测路径，但整个系统中没有任何代码会写入 `completed:` 前缀到 SopTracker，所以该路径永远不会执行。正则仍然是唯一的 phase 检测手段

### Bug 2：`buildAutoResumeMessage` 缺少 `lastCompletedStep`
- **文件**：`auto-resume.ts:19-29`
- **状态**：在 a54cd24 中已修复（添加了 `last=` 字段）

### Bug 3：bookmark 在 SOP 推进之前提取
- **文件**：`message-service.ts`
- **状态**：在 a54cd24 中已修复（bookmark 提取移到 `advanceSopIfNeeded()` 之后）

### Bug 4：`shouldAutoResume` 的 fillRatio 安全阀被过度矫正
- **文件**：`message-service.ts:1247`
- **证据**：`shouldAutoResume(parsedBookmark, resumeCount, MAX_AUTO_RESUMES, lastFillRatio ?? 0)`
- **问题**：`lastFillRatio` 是触发 seal 的旧 session 的 fill ratio（通常 > 0.8），传给 `shouldAutoResume` 后 `0.8 > 0.5` → 自动续接永远不触发
- **首次修复（a54cd24）为何无效**：只添加了 `phase=completed` 短路检测，但 `completed:` 前缀从未被设置（Bug 1），所以短路从未触发。同时 fillRatio 参数仍然传入旧 session 的值

## 5. 修复方案（第二次修复，彻底解决）

| Bug | 修复 | 文件 | 理由 |
|-----|------|------|------|
| 1 | **彻底删除 `PHASE_PATTERNS` 正则数组**。`extractSOPBookmark` 改为直接使用 `currentSopStage`（SopTracker 的结构化 stage 名）作为 `skill` 和 `phase`。`lastCompletedStep` 改为 agent 输出的最后 200 字符（真实上下文，而非正则片段） | `sop-bookmark.ts` | 正则在自然语言上不可靠且无法区分"正在做"和"已经做完"。sopTracker 的 stage 名是结构化数据，100% 准确 |
| 2 | 保持 a54cd24 的修复 | `auto-resume.ts` | 已正确 |
| 3 | 保持 a54cd24 的修复 | `message-service.ts` | 已正确 |
| 4 | **传 0 作为 newSessionFillRatio**（新 session 上下文为空）。在 `advanceSopIfNeeded` 中添加 cycle 检测：当 `advance()` 返回 null（终端 skill）或返回 `feat-lifecycle`（链条循环回起点）时，设置 `completed:<skill>` 使 bookmark 进入 completed 状态 | `message-service.ts` | seal 后新 session 是空的（fillRatio ≈ 0），旧 session 的 fillRatio 不应阻断续接。cycle 检测确保 `completed:` 前缀真正可达 |

**放弃的备选**：不考虑"改正则让它更准"——正则在自然语言匹配上是死胡同，再精确的正则也无法区分"我在做 review"和"我已经做完了 review"。

## 6. 验证方式

### Bug 1 验证
- 新增 3 个测试：`B014-Bug1` 系列
  - agent 输出含"review"但 stage 是 `feat-lifecycle` → phase 必须是 `feat-lifecycle`，不是 `review`
  - agent 输出含"merge"但 stage 是 `tdd` → phase 必须是 `tdd`，不是 `merge`
  - `lastCompletedStep` 包含有意义的输出上下文（如"91 测试全绿"），而非正则匹配的碎片
- 旧测试全部更新为新语义（phase = stage 名称）

### Bug 4 验证
- `shouldAutoResume` 的 `completed` 短路测试（已有，现在 completed 路径可达）
- `advanceSopIfNeeded` 的 cycle 检测：`merge-gate` 完成后 stage 变为 `completed:merge-gate`，不是 `feat-lifecycle`
- 终端 skill（如 `self-evolution`）完成后 stage 变为 `completed:self-evolution`
- `shouldAutoResume(completedBookmark, ...)` 返回 false

### 回归验证
- 全量测试：217 pass / 0 fail
- TypeScript 编译：0 errors
- 原 B012 `a54cd24` 修复的 Bug 2、Bug 3 功能不受影响
