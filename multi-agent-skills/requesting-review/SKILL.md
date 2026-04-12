---
name: requesting-review
description: >
  向 peer-reviewer 发送 review 请求（含五件套）。
  Use when: 自检通过后准备请其他 agent review。
  Not for: 收到 review 结果（用 receiving-review）、自检（用 quality-gate）。
  Output: Review 请求信。
triggers:
  - "请 review"
  - "帮我看看"
  - "request review"
  - "准备 review"
---

> **SOP 位置**: acceptance-guardian 通过后 → **本 skill** → `receiving-review`

# Request Review

把改动送到 reviewer 眼前，让 reviewer 花时间在重点上——不是基础检查上。

## 核心知识

### 前置条件（全部满足才能发请求）

| 条件 | 检查方式 | 未满足时 |
|------|----------|----------|
| `quality-gate` 通过 | 有本轮 gate report | BLOCKED — 先跑 quality-gate |
| `acceptance-guardian` 通过 | 有 PASS 判定 | BLOCKED — 先跑 acceptance-guardian |
| 测试全绿 | 附测试命令输出 | BLOCKED — 修到绿灯再发 |
| 原始需求可引用 | feature doc 路径 + ≤5 行小孙原话 | BLOCKED — reviewer 有权拒绝审查 |

> **教训**：review 信只附了 spec 没附原始需求。结果多轮 review 全在抓 edge case，没人发现"UI 不可用"。Reviewer 没有上下文，无法做愿景验证。

### Reviewer 匹配规则

**三人都不能 review 自己的代码**：

```
优先级（从高到低）：
1. 非实现者、非 quality-gate 执行者
2. 当前可用（无正在进行的 review 任务）
3. 领域匹配（后端→范德彪优先，前端→桂芬优先）
```

## 流程

```
BEFORE 发 review 请求:

1. 确认 quality-gate + acceptance-guardian 已通过
2. 确认测试全绿（附这次真实运行的输出）
3. 找到原始需求文档路径 + 摘录 ≤5 行小孙原话
4. 匹配 reviewer（非作者优先）
5. 用模板写 review 请求
6. 发给 reviewer
```

## Review 请求模板

```markdown
## Review Request

**Feature:** F{NNN} — docs/features/F{NNN}-xxx.md
**Branch:** feat/{feature-name}
**Reviewer:** {reviewer 名}

### What Changed
{改动描述 + 涉及文件列表}

### Why
{为什么做这次改动 + 约束}

### Original Requirements
> {小孙原话 ≤5 行，来自 feature doc}
>
> 来源：{文档路径}

请对照判断实现是否符合原始需求。

### Self-Check Evidence
- quality-gate: ✅ {报告摘要}
- acceptance-guardian: ✅ PASS
- pnpm test: {N}/{N} pass

### Known Risks
{已知风险点}

### Review Focus
1. {重点 1}
2. {重点 2}

### Out of Scope
{本次不看什么}
```

## Block 场景

### ❌ 没有 quality-gate 报告

```
⚠️ BLOCKED — 缺少 quality-gate 自检报告

请先运行 quality-gate skill，确认：
- 原始需求逐项对照
- 测试全绿
- 有本轮输出证据

再发 review 请求。
```

### ❌ 没有原始需求摘录

```
⚠️ BLOCKED — 缺少原始需求文档

请附上：
- feature doc 路径
- ≤5 行小孙原话摘录

Reviewer 不只审代码质量，还要判断"这是小孙要的吗？"
没有原始需求 = Reviewer 无法做愿景验证 = 有权拒绝审查。
```

### ❌ 测试未通过

```
⚠️ BLOCKED — 测试未全绿

请先修复，再发请求：
  pnpm test  # 必须 0 failures

Reviewer 不应该是第一个发现测试失败的人。
```

## Common Mistakes

| 错误 | 正确做法 |
|------|----------|
| "帮我 review 一下" 没有上下文 | 用模板写完整请求 |
| 没跑 quality-gate 就发请求 | 先自检 + acceptance-guardian |
| 只附 spec 没附原始需求 | 必须附小孙原话 + 来源 |
| 自己选自己当 reviewer | 三人不能 review 自己的代码 |
| 跳过 acceptance-guardian 直接请 review | 流程是 quality-gate → acceptance-guardian → requesting-review |

## 和其他 skill 的区别

| Skill | 关注点 | 时机 |
|-------|--------|------|
| `quality-gate` | 自检（spec 对照 + 证据） | review **之前** |
| `acceptance-guardian` | 零上下文独立验收 | quality-gate **之后** |
| **requesting-review（本 skill）** | 把改动送到 reviewer 面前 | acceptance-guardian 通过**之后** |
| `receiving-review` | 处理 reviewer 的反馈 | 收到 review **之后** |

## 下一步

Review 请求发出后 → 等 reviewer 回复 → **直接进入 `receiving-review`** 处理反馈。
