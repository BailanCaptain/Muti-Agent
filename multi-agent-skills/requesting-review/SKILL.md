---
name: requesting-review
description: 当准备请求 reviewer 做代码审查时触发。强制先自检，再明确 review 范围、风险点和期望。
---
---

# Core Principle

好的 review 请求不是“帮我看看”，而是提供可审查对象、审查重点和风险背景。
如果请求方不先自检，review 很容易退化成 reviewer 替作者补基本功。

## 检查流程

BEFORE 请求 review:
1. CHECK: 是否先完成最小自检
   - 改动目标是否明确
   - 关键路径是否自己走通过
   - 相关测试是否运行
   - 已知风险是否标注
2. CHECK: 是否明确 review 范围
   - 改了哪些文件
   - 本次 review 看什么，不看什么
3. CHECK: 是否说明 Why
   - 为什么做这次改动
   - 约束是什么
4. BLOCK: 如果没有自检结果，禁止直接请求 review
5. BLOCK: 如果没有说明审查重点，禁止只发“请 review”
6. PASS: 自检 + 背景 + 范围齐全后，才允许请求 review

## 请求格式

### Review Request
- What Changed:
- Why:
- Self-Check:
- Known Risks:
- Review Focus:
- Out of Scope:

## Block 场景

### 反例
帮我 review 这段代码。

为什么阻止：
- reviewer 不知道你是否跑过测试
- reviewer 不知道你自己已经验证到什么程度
- 会浪费 review 资源在基础检查上

## 通过场景

### 正例
### Review Request
- What Changed:
  修改了 `agent-router.ts`、`mention-parser.ts`、`conversation-store.ts`，实现被 @ 的协作者自动入场。
- Why:
  当前协作者只能在单轮请求中被动响应，无法在房间上下文中持续参与聊天，这会阻塞当前项目目标。
- Self-Check:
  - 本地手测了单协作者 / 双协作者 @ 场景
  - 跑过 `mention-parser` 单测
  - 未覆盖协作者并发入场
- Known Risks:
  - 多个协作者同时被 @ 时，消息顺序可能不稳定
  - conversation-store 目前没有幂等保护
- Review Focus:
  1. 入场时机是否合理
  2. 状态写入是否存在竞态
  3. API 边界是否便于后续接 CLI / MCP
- Out of Scope:
  UI 样式和文案不是这次 review 重点
