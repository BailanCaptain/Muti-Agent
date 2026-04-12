---
name: acceptance-guardian
description: >
  零上下文独立验收：专用 agent 对 feature 做 AC 验收，对 bugfix 按复现步骤/验证方式复跑并检查是否真的消除 bug 现象、是否引入新 bug 或历史 bug 回归。
  Use when: quality-gate 通过后、进入 review 前，需要独立验收当前交付。
  Not for: 自检（用 quality-gate）、代码审查（用 code-review）、收到 review 反馈后的修复（用 receiving-review）。
  Output: 独立验收报告（✅/❌/⚠️） + PASS/BLOCKED/ESCALATE 判定。
---

# Acceptance Guardian（独立验收守护）

## 核心理念

**零上下文 agent 消除确认偏差。**

实现者已经知道自己改了什么，最容易把"改过了"误判成"修好了"。独立验收守护只看任务文本、代码、测试、文档，不看实现过程。

## 两种验收模式

### Feature Mode

用于 feature / refactor / enhancement 交付。

- 真相源：feature doc / AC checklist / Discussion 原话
- 核心问题：每个 AC 是否真的落地，且有代码与测试证据

### Bug Mode

用于 bugfix / debugging 后的修复验收。

- 真相源：bug report、其中的 **bug 现象 / 复现步骤 / 验证方式**
- 核心问题：原复现路径下，旧 bug 现象是否消失；修复是否引入新 bug；是否撞上历史 bug 回归

## 触发条件

quality-gate PASS 后自动进入。**不可跳过。**

## 流程

### Step 1: 实现者准备守护请求

选择**非实现者** agent，发送守护请求。

#### Feature 请求模板

```markdown
@{非实现者 agent} [acceptance-guardian]
请做独立验收。

Feature: docs/features/Fxxx-name.md
AC:
- [ ] AC1: {验收条件}
- [ ] AC2: {验收条件}

代码在分支: feat/{feature-name}
```

#### Bug 请求模板

```markdown
@{非实现者 agent} [acceptance-guardian]
请按 bug report 做独立验收。

Bug Report: docs/bugReport/Bxxx-name.md
重点观察:
- Bug 现象: {一句话}
- 复现步骤: {引用或摘要}
- 验证方式: {引用或摘要}
```

### Step 2: 守护 agent 判定模式

收到请求后，先判断：

1. 有 feature doc / AC checklist → **Feature Mode**
2. 有 bug report / 复现步骤 / 验证方式 → **Bug Mode**
3. 两者都在 → 先按 bug mode 验修复，再按 feature mode 验交付完整性

### Step 3: 守护 agent 执行验收

#### Feature Mode

对每一个 AC：

1. 找到对应代码实现
2. 找到对应测试覆盖
3. 运行相关测试
4. 输出：
   - ✅ 通过：附代码位置 + 测试名 + 本次运行结果
   - ❌ 未通过：附原因（找不到实现 / 无覆盖 / 测试失败 / 行为不符）

#### Bug Mode

按顺序执行，不允许跳步：

1. 读取 bug report 中的 **bug 现象 / 复现步骤 / 验证方式**
2. 严格按**原复现步骤**复跑
3. 观察**原 bug 现象**是否仍然出现
4. 按**验证方式**复跑回归测试 / 关键路径
5. 搜索 `docs/bugReport/B*.md`，判断是否像：
   - 当前 bug 的未修净残留
   - 历史 bug 回归
   - 新 bug
6. 输出：
   - ✅ 通过：原复现路径已不再出现该 bug 现象，验证方式通过
   - ❌ 未通过：原复现路径仍能复现，或验证失败
   - ⚠️ 可疑：旧现象消失，但冒出像新 bug / 历史 bug 回归的问题

### Step 4: 新 bug / 历史 bug 判断规则

守护 agent 必须**先给技术判断，再升级小孙**，不能把不确定性直接甩给人。

#### 历史 bug 回归

如果当前异常与 `docs/bugReport/` 中已有问题的现象、链路、根因明显相似：

- 标记为 **BLOCKED**
- 指出疑似回归的 Bxxx 文档
- 说明相似点与差异点

#### 疑似新 bug

如果当前异常不符合当前 bug report，也对不上历史 bug：

- 先写出你的初判：为什么像新 bug，为什么不像当前修复残留
- 输出 **ESCALATE**
- 明确要求询问小孙：这个新问题是否阻塞当前交付，还是单开新 bug

### Step 5: 守护报告格式

```markdown
## Acceptance Guardian Report

**Mode**: Feature | Bug | Hybrid
**Target**: Fxxx / Bxxx
**守护 Agent**: {agent 名}
**检查时间**: YYYY-MM-DD HH:MM

### 检查结果
| # | 检查项 | 状态 | 证据 |
|---|--------|------|------|
| 1 | AC1 / 复现步骤 1 | ✅ | `file.ts:42` + `test.ts::name` PASS |
| 2 | Bug 现象是否消失 | ❌ | 按步骤复跑后仍出现同样报错 |
| 3 | 是否引入新 bug / 历史 bug 回归 | ⚠️ | 疑似 B012 回归 / 疑似新 bug |

### 判定
**PASS** — 交付通过，可进入 review
或
**BLOCKED** — 当前交付未通过，需返回实现者修复
或
**ESCALATE** — 发现疑似新 bug，需先询问小孙是否阻塞当前交付
```

## 判定规则

- **PASS**：全部检查通过，且未发现新 bug / 历史 bug 回归风险
- **BLOCKED**：原 AC 未满足，或原 bug 现象仍可复现，或明显撞上历史 bug 回归
- **ESCALATE**：出现疑似新 bug，守护 agent 已给初判，但需要小孙决定是否阻塞

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 只看代码 diff 就判定修好了 | 按 feature AC 或 bug 复现路径实际复跑 |
| bug 验收只跑测试，不走原复现步骤 | 先按原路径观察旧 bug 现象是否消失 |
| 发现异常就直接说"新 bug" | 先查 `docs/bugReport/`，做技术初判 |
| 可疑问题直接 BLOCKED | 如果像新 bug 但未坐实，先 ESCALATE 给小孙 |
| 实现者自己做守护 | 必须是非实现者、零上下文 agent |

## 下一步

- **PASS** → 进入 `requesting-review`
- **BLOCKED** → 返回实现 → `quality-gate` → 再次 `acceptance-guardian`
- **ESCALATE** → 先问小孙，再决定是开新 bug 还是阻塞当前交付
