---
name: vision-guardian
description: >
  零上下文愿景守护：专用 agent 逐项验收 AC，消除确认偏差。
  Use when: quality-gate 通过后、进入 review 前，需要独立验收。
  Not for: 自检（用 quality-gate）、代码审查（用 requesting-review）。
  Output: 逐项验收报告（✅/❌） + PASS/BLOCKED 判定。
---

# Vision Guardian（愿景守护）

## 核心理念

**零上下文 agent 消除确认偏差。**

实现者在数小时开发后，心理上已经"完成了"，很难客观验收。一个全新 agent 实例只看需求文档和代码，没有实现过程的记忆污染——这才是真正的独立验收。

## 为什么不是 quality-gate 的一部分？

| | quality-gate | vision-guardian |
|--|-------------|----------------|
| **谁** | 实现者自己 | **非实现者，零上下文** |
| **看什么** | 代码 + spec + 运行输出 | **只看 feature doc + AC + 代码** |
| **偏差** | 有（实现过程记忆） | **无（全新 agent 实例）** |
| **目的** | 确保代码质量 | **确保需求满足** |

## 触发条件

quality-gate PASS 后自动进入。**不可跳过。**

## 流程

### Step 1: 实现者准备守护请求

实现者从 feature doc 提取完整 AC checklist，发送守护请求：

```
@{非实现者 agent} [vision-guardian]
请对照以下 feature doc 逐项验收。

Feature: docs/features/Fxxx-name.md
AC:
- [ ] AC1: {验收条件}
- [ ] AC2: {验收条件}
- [ ] AC3: {验收条件}

代码在分支: feat/{feature-name}
```

**选择守护 agent 的规则**：
- 守护 agent ≠ 实现者
- 优先选择与实现工作无关的 agent
- 示例：黄仁勋实现 → @范德彪 或 @桂芬 守护

### Step 2: 守护 agent 执行验收

守护 agent 收到**专用 system prompt**（不含身份/团队/家规，只有守护职责）。

**守护 agent 的工作**：

对每一个 AC 项：
1. **找代码**：在代码库中定位实现该 AC 的代码
2. **找测试**：确认有测试覆盖该 AC
3. **跑测试**：运行相关测试，确认通过
4. **输出判定**：
   - ✅ 通过 — 附证据（文件:行号 + 测试名 + 运行输出）
   - ❌ 未通过 — 附原因（找不到实现 / 无测试覆盖 / 测试失败 / 行为不符合 AC）

### Step 3: 守护 agent 输出报告

```markdown
## Vision Guardian Report

**Feature**: F{NNN} — {Feature Name}
**守护 Agent**: {agent 名}
**检查时间**: YYYY-MM-DD HH:MM

### 逐项验收
| # | AC | 状态 | 证据 |
|---|-----|------|------|
| 1 | AC1 描述 | ✅ | `src/file.ts:42` + `test.ts::testName` PASS |
| 2 | AC2 描述 | ❌ | 找不到对应实现 |

### 判定
**PASS** — 全部 AC 通过，放行进入 review。
或
**BLOCKED** — 以下 AC 未通过：[列表]。踢回实现者修改。
```

### Step 4: 根据判定行动

- **PASS** → 进入 `requesting-review`
- **BLOCKED** → 实现者修改 → 重新过 `quality-gate` → 重新触发 `vision-guardian`

## 专用 System Prompt

守护 agent 的 system prompt **不包含**：
- agent 身份信息
- 团队成员名册
- 家规 / shared-rules
- 工作流路由表

守护 agent 的 system prompt **只包含**：
- "你是愿景守护者"
- 验收工作流程
- 输出格式要求
- "你没有实现上下文，只看文档和代码"

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 实现者自己做守护 | 必须是非实现者 agent |
| 守护 agent 有实现上下文 | 必须是全新调用，零上下文 |
| AC 未全部检查就放行 | 每一项都必须检查 |
| "应该能过"就标 ✅ | 必须有代码证据 + 测试运行输出 |
| BLOCKED 后不重新走 quality-gate | 修改后必须从 quality-gate 重新开始 |

## 下一步

- **PASS** → 进入 `requesting-review`
- **BLOCKED** → 返回实现 → `quality-gate` → 再次 `vision-guardian`
