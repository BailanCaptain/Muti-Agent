---
name: cross-role-handoff
description: >
  跨角色交接的五件套结构（What/Why/Tradeoff/Open/Next）。
  Use when: 交接工作给其他 agent、传话、写 review 信。
  Not for: 自己的任务、不涉及其他 agent 的工作。
  Output: 结构化交接信。
triggers:
  - "交接"
  - "传话"
  - "handoff"
  - "转交"
---

# Cross-Role Handoff

**Core principle:** 交接不能只写"改了什么"。没有 Why = 接手方无法判断 = 低效协作。

> 五件套是铁律（shared-rules §9）。缺任何一项 = BLOCKED。

## 五件套（必须全部包含）

每次交接/传话/review 请求必须包含：

| # | 项目 | 说明 | 示例 |
|---|------|------|------|
| 1 | **What** | 具体改动或决策 | "新增了 CAS 保护状态更新" |
| 2 | **Why** | 为什么这样做 | "内存 store 返回活引用导致竞态" |
| 3 | **Tradeoff** | 放弃了什么备选 | "考虑过乐观锁，但原子操作更简" |
| 4 | **Open Questions** | 还不确定的点 | "重试次数是否足够" |
| 5 | **Next Action** | 希望接手方做什么 | "请 review 这三个文件的改动" |

## 检查流程

```
BEFORE 发送交接/传话/review请求:

1. SCAN: 检查消息是否包含五件套
2. MISSING: 识别缺失项
3. BLOCK: 如有缺失，阻止发送并提示补充
4. PASS: 全部包含，允许发送
```

## Block 场景

### ❌ 只写 What

```
准备写: "@范德彪 我改完了三个文件，帮我 review"

⚠️ BLOCKED — 交接缺失必要信息

缺失项:
- ❌ Why: 为什么要改？
- ❌ Tradeoff: 有没有考虑过其他方案？
- ❌ Open Questions: 有什么不确定的？
- ❌ Next Action: 希望 review 什么重点？

请补充五件套后再发送。
```

### ❌ 只有 What + Why

```
准备写: "@范德彪 我加了 CAS 保护，因为发现竞态问题"

⚠️ BLOCKED — 交接缺失必要信息

已有:
- ✅ What: 加了 CAS 保护
- ✅ Why: 发现竞态问题

缺失:
- ❌ Tradeoff: 为什么选 CAS？考虑过其他方案吗？
- ❌ Open Questions: 有什么不确定的？
- ❌ Next Action: 希望 reviewer 做什么？

请补充后再发送。
```

## 通过场景

### ✅ 完整的交接

```markdown
## 交给范德彪 Review: 愿景守护运行时注入

### What
在 context-assembler 中实现 vision-guardian 零上下文模式：
- 新增 POLICY_GUARDIAN（零上下文策略）
- assemblePrompt 检测 visionGuardianMode → 替换 system prompt
- flushDispatchQueue 中 skill match 检测 vision-guardian → 启用 guardian 模式

### Why
vision-guardian 的核心设计是"零上下文消除确认偏差"——agent 不能带实现记忆去验收。
必须在运行时层面替换 system prompt，否则身份/团队/家规信息会泄漏到守护 agent。

### Tradeoff
考虑过在 CLI 层面新建独立 agent 进程，但成本太高（新进程 + 配置 + 生命周期管理）。
选择在 prompt 注入层替换更轻量，且复用现有 dispatch 基础设施。

### Open Questions
1. 当前检测方式是 skillHint 包含 "vision-guardian"，是否需要更精确的匹配？
2. guardian 模式下 MCP 工具是否也应该受限？

### Next Action
请 review 这三个文件：
1. context-policy.ts — POLICY_GUARDIAN 定义
2. context-assembler.ts — visionGuardianMode 分支
3. message-service.ts — 检测逻辑

重点关注：零上下文是否真的零（有没有信息泄漏路径）
```

## 四种交接类型

### 1. Review 请求

交给其他 agent 审查代码。**重点**：What（改了哪些文件）+ Why + Next Action（review 焦点）。

### 2. 工作交接

一位 agent 做到一半，另一位接手。**重点**：What（当前进度）+ Open Questions（卡点）+ Next Action（下一步建议）。

### 3. 决策通知

通知其他 agent 一个重要决策。**重点**：What（做了什么决定）+ Why + Tradeoff（放弃了什么）。

### 4. 开放讨论邀请

邀请其他 agent 讨论方向性问题（不是任务指派）。**特殊规则**：
- 这是讨论，不是任务
- 给开放问题，不问引导性问题
- 透明展示推理链
- 让对方先形成自己的想法再看你的分析

详见 `collaborative-thinking` skill 的 Mode B。

## 五件套自检清单

```
交接五件套自检:
- [ ] What: 具体改动/决策是什么？
- [ ] Why: 为什么这样做？约束/风险/目标是什么？
- [ ] Tradeoff: 放弃了什么备选方案？
- [ ] Open Questions: 还有什么不确定的？
- [ ] Next Action: 希望接手方下一步做什么？
```

## Common Mistakes

| 错误 | 问题 | 正确做法 |
|------|------|----------|
| "帮我 review 这个" | 不知道该关注什么 | 说明 review 重点 |
| "我改完了" | 不知道改了什么/为什么 | 写明 What + Why |
| "按你说的改了" | 不知道改对了没 | 说明具体改了什么 |
| "遇到问题，你看看" | 不知道具体问题 | 描述问题 + 你的分析 |
| 紧急 hotfix 跳过五件套 | 上下文丢失 | 至少写 What+Why，Tradeoff 标注"后续补充" |
| 多人链式交接只写一份 | 中间人丢信息 | 每段交接独立五件套 |

## 下一步

- 交接 review 请求 → 接收方用 `receiving-review`
- 交接开发工作 → 接收方用 `worktree` + `tdd` 开始
- 交接讨论邀请 → 接收方用 `collaborative-thinking`

## 参考

五件套详见：`multi-agent-skills/refs/shared-rules.md` §9（铁律：交接五件套）
