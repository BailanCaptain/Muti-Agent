---
name: receiving-review
description: >
  处理 reviewer 反馈：VERIFY 三道门 + Red→Green 修复（禁止表演性同意）。
  Use when: 收到 review 结果、reviewer 提了 P1/P2、需要处理反馈。
  Not for: 发 review 请求（用 requesting-review）、自检（用 quality-gate）。
  Output: 逐项修复确认 + reviewer 放行。
triggers:
  - "review 结果"
  - "review 意见"
  - "reviewer 说"
  - "fix these"
  - "修复 review"
---

> **SOP 位置**: `requesting-review` → **本 skill** → `merge-gate`

# Receive Review

处理 reviewer 反馈的完整流程。核心原则：**技术正确性 > 社交舒适，验证后再实现，禁止表演性同意。**

## 核心知识

### 两类反馈，处理方式不同

| 类型 | 特征 | 处理 |
|------|------|------|
| **代码级** | bug / edge case / 性能 / 命名 | Red→Green 修复流程 |
| **愿景级** | "这不是小孙要的" / "缺了核心功能" / "UI 不可用" | STOP → 回读原始需求 → 和小孙确认 |

> **愿景级反馈不能用代码 patch 修补设计问题。** 先对照小孙原话验证 reviewer 说得对吗；如确实偏离，升级小孙确认偏差范围，再重新设计。

### 禁止的响应（表演性同意 + fail-closed 结论词）

**表演性同意**（社交性附和，不是修复）：
```
❌ "You're absolutely right!"    ❌ "Great point!"
❌ "Excellent feedback!"         ❌ "Thanks for catching that!"
❌ "让我现在就改"（验证之前）    ❌ "我马上改"
```

**fail-closed 结论词**（未验证前禁用，对齐家规 §P5）：
```
❌ "fixed"     ❌ "已修复"     ❌ "完成"      ❌ "没问题"
❌ "确认 OK"   ❌ "搞定"       ❌ "一定是 X"  ❌ "pass 了"
```

允许：`我推测` · `我计划` · `目前看起来` · `已改 + 待验证`

行动说明一切——直接修复，代码本身证明你听到了反馈。

### Push Back 标准

当以下情况时**必须** push back，用技术论证，不是防御性反应：

- 建议会破坏现有功能
- Reviewer 缺少完整上下文
- 违反 YAGNI（过度设计）
- 与架构决策/小孙要求冲突
- 建议会让实现**更偏离**小孙原始需求

如果你 push back 了但你错了：陈述事实然后继续，不要长篇道歉。

**Review 有零分歧 = 走过场。** 真正的 review 需要技术争论。

## 流程

```
WHEN 收到 review 反馈:

1. READ     — 完整读完，不要边读边反应
2. CLASSIFY — 区分愿景级 vs 代码级；按 P1/P2/P3 分优先级
3. CLARIFY  — 有不清晰的问题先全部问清，再动手
4. VERIFY   — reviewer 说的问题真的存在吗？（见下方三道门）
5. FIX      — 通过验证的问题 Red→Green 逐个修复
6. CONFIRM  — 修完回给 reviewer 确认，不能自判"改对了"
```

### VERIFY 三道门（少一道不准照改）

对每条 review 意见，**改代码之前**必须过三道门：

1. **Spec Gate** — 这条意见和现有 AC/需求冲突吗？
   - 冲突 → pushback，附 AC 原文
   - 不冲突 → 进下一道

2. **Mechanism Gate** — reviewer 说"这不行"的证据是什么？
   - 有失败用例 / 真实平台限制 → 进下一道
   - 只是"不优雅"/"理论上不安全"但拿不出失败路径 → 当假设处理，pushback 要求证据

3. **Feature Gate** — 按建议改完后，核心用户路径还活着吗？
   - 改完跑一遍最关键的用户路径（不是只跑测试）
   - 功能死了 → 回滚，review 建议作废，不管它理论上多优雅

**修复顺序**：P1（blocking）→ P2（必须修）→ P3（讨论后当场修或放下）

**澄清原则**：有任何问题不清晰，先 STOP，全部问清再动手。部分理解 = 错误实现。

### 假绿自检（对齐家规 §17）

声明"fixed / 完成"前先自查：

- [ ] 本轮给了新文件+行号 / 新测试 / 新实测输出，不是换说法
- [ ] 同一 finding 第几次声明 fixed？
  - 第 1 次：附证据递回
  - 第 2 次：**已触碰阈值**——修前先写 Red 测试锁死，否则 reviewer 会接管

自查不过 → 回 VERIFY 三道门重来。

## Red→Green 修复流程

对每个 P1/P2 问题：

```
1. 理解问题（复述给自己听）
2. 写失败测试（Red）
3. 运行测试，确认红灯
4. 修复代码
5. 运行测试，确认绿灯（Green）
6. 运行完整测试套件，确认无 regression
```

**例外**：如果无法稳定自动化复现，提供最小手工复现步骤 + 说明原因，但不能跳过验证。

## 修复后确认（硬规则）

**修复完成 ≠ 可以合入。必须回给 reviewer 确认。**

```
❌ 错误：修复 → 自己判断"改对了" → 合入 dev
✅ 正确：修复 → 回给 reviewer → reviewer 确认 → 进 merge-gate
```

确认信格式：

```markdown
## 修复确认请求

| # | 问题 | 状态 | Red→Green |
|---|------|------|-----------|
| P1-1 | {描述} | ✅ | {test file}: FAIL → PASS |
| P2-1 | {描述} | ✅ | {test file}: FAIL → PASS |

测试结果：pnpm test → {X} passed, 0 failed
Commit: {sha} — {message}

请确认修复，确认后执行合入。
```

## TAKEOVER 降级

触发条件完全对齐家规 §17（`multi-agent-skills/refs/shared-rules.md`）。以下任一满足即触发：

1. 同一 bug/feature 内，author 连续 2 次声称 fixed/完成但复验失败
2. 连续 3 轮无证据增量（只换说法，没有新文件+行号 / 新测试 / 新实测输出）

**触发后**：在消息中显式宣布 TAKEOVER → 原 author 降级为"信息提供者"停止试错 → 另一位 agent 接手修复。接管 agent 不得自审，需由第三方 review。

**对等责任**：达到阈值不接管 = reviewer 失职。TAKEOVER 不是"有权"，是"有责"。

## Common Mistakes

| 错误 | 正确做法 |
|------|----------|
| 边读边改，没读完 | 读完整反馈，分类后再动手 |
| 有不清晰的问题但先改清晰的 | 全部澄清后再统一动手 |
| 没写 Red 测试直接改代码 | 先写失败测试，确认红灯，再修 |
| 修完自判"对了"直接合入 | 必须回给 reviewer 确认 |
| 全盘接受，零 push back | 有技术理由必须说出来（VERIFY 三道门） |
| 愿景级问题用代码 patch | STOP，升级小孙，不要硬修 |

## 和其他 skill 的区别

| Skill | 关注点 | 时机 |
|-------|--------|------|
| `quality-gate` | 自己检查自己 | 提 review 之前 |
| `requesting-review` | 发出 review 请求 | 自检通过之后 |
| **receiving-review（本 skill）** | 处理 reviewer 的反馈 | 收到 review 之后 |
| `merge-gate` | 合入前门禁 + PR | reviewer 放行之后 |

## 下一步

Reviewer 放行（"LGTM"/"通过"/"可以合入"/"Approved"）→ **直接进入 `merge-gate`**。不要停下来问小孙。
