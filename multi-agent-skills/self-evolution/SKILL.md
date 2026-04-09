---
name: self-evolution
description: >
  Scope Guard + Process Evolution + Knowledge Evolution — 主动护栏与自我进化。
  Use when: 小孙 scope 发散偏离愿景、同类错误反复出现、SOP 流程缺口、有价值的知识/方法论值得沉淀。
  Not for: 日常 SOP 推进、一次性个案 bug fix。
  Output: Scope Guard 记录 / Evolution Proposal / 知识沉淀。
triggers:
  - "scope 偏了"
  - "又犯了"
  - "重复错误"
  - "流程改进"
  - "值得记住"
  - "self-evolution"
argument-hint: "[mode: scope-guard|process|knowledge] [主题]"
---

# Self-Evolution — Scope Guard + Process Evolution + Knowledge Evolution

> 团队共用。agent 是主动的共创伙伴，不是被动的执行者。
> 发现问题就护栏，发现规律就改进，发现知识就沉淀。

## 三个模式

| 模式 | 方向 | 保护/推动什么 | 触发 | 产出物 |
|------|------|---------------|------|--------|
| **A: Scope Guard** | 防御 | 当前 feat 验收边界 | 小孙讨论偏离愿景 | Scope Guard 记录 |
| **B: Process Evolution** | 防御→改进 | 团队流程持续改进 | 重复犯错 / 流程缺口 | Evolution Proposal |
| **C: Knowledge Evolution** | 进攻→成长 | 团队能力边界扩展 | 有价值的知识/方法论产生 | 知识沉淀 |

---

## Mode A: Scope Guard

### 触发信号

看**是否越过当前 feat 契约**——满足 2 个普通信号或 1 个强信号：

| 信号 | 强度 |
|------|------|
| 新想法不直接服务当前愿景/验收条件 | 普通 |
| 新想法引入新的用户旅程/新页面/新子系统 | **强** |
| 新想法需要新的外部依赖/API/数据模型 | **强** |
| 新想法导致"这次怎么验收"说不清了 | **强** |

### 行为

> 小孙，先收一下：当前 feat 愿景是 **{愿景}**。刚才提到的 **{新方向}** 更像独立 feat / 下一 phase。要不要拆出去方便验收？

- 同一 phase **最多两次**：第一次温柔，第二次明确说"建议碰头"
- 小孙说"不拆" → 复述新验收边界，不再追问
- 出口：继续 / 拆 feat / parking lot / 碰头

---

## Mode B: Process Evolution

### 触发（任一）

1. 同类错误 **≥ 2 次**
2. 小孙纠正了**可泛化为规则**的行为
3. SOP 执行中发现**没有指引**
4. Review 指出**系统性问题**（非个案 bug）

### 提案流程

1. **写提案**（5 槽模板）：

| # | 槽位 | 说明 |
|---|------|------|
| 1 | **Trigger** | 什么触发了这个提案 |
| 2 | **Evidence** | 至少 2 个来源的证据 |
| 3 | **Root Cause** | 为什么会反复出现 |
| 4 | **Lever** | 最小杠杆改动（见下方排序） |
| 5 | **Verify** | 怎么验证改进有效 |

2. **审批**：影响单 agent → 直接提小孙；影响全团队 → 先 1 agent sanity check → 小孙拍板
3. **落地闭环**：accepted → 必须关联 commit/PR，不能停在"提了"

### 最小杠杆排序

复述 scope → 改 memory → 改单 skill → 改 SOP/shared-rules → 改 SystemPrompt → 改 L0

### 硬护栏

1. **证据 ≥ 2 源** — 不凭感觉
2. **最小杠杆优先** — 能改 memory 不改 skill，能改 skill 不改 SOP
3. **先修当前，再提改进** — 不拿建议逃避当前任务
4. **提案要短** — 5 槽，不写长篇反思

---

## Mode C: Knowledge Evolution

> 不只从错误中学习，也从有价值的经验中成长。

### 触发（任一）

1. Deep research 产出了跨场景可复用的知识或框架
2. 专业领域讨论形成了可迁移的分析方法论
3. 跨域协作中发现了可复用的协作模式
4. 小孙说"这个值得记住"或 agent 自主判断有高复用价值

### 判断标准：值得沉淀吗？

问三个问题：
- **复用性**：未来类似场景还会用到吗？
- **非显然性**：这个知识/方法不容易从头推导出来吗？
- **衰减性**：不记下来，下次还能想起来吗？

三个中满足 ≥ 2 个 → 值得沉淀。

### 沉淀方式

| 条件 | 沉淀成 | 位置 |
|------|--------|------|
| 高风险/跨领域分析框架 | Method Card | `docs/methods/` |
| 重复步骤稳定的流程型任务 | Skill Draft | 走 `writing-plans` 拆分 |
| 轻量知识点 | Memory file | `.claude/` memory 系统 |

### 护栏

- **不是每次对话都沉淀** — 只沉淀过了三问判断的知识
- **沉淀不是目的，可调用才是** — 写了没人读 = 没写
- **已有的不重复写** — 先搜再写，避免知识碎片化

---

## 共用规则

- **不发明新沉淀库**：路由到现有真相源（Method / Skill / memory / feature docs）
- **出口闭环**："改" → 改文件 + commit ｜ "不改" → 记录已评估不重复提 ｜ "先记着" → parking lot
- **三模式出口都一样**：闭环后回到当前工作

## Common Mistakes

| 错误 | 正确做法 |
|------|----------|
| 凭感觉提建议 | 要证据（≥ 2 源） |
| 每句话都建议改进 | 只在触发条件满足时提 |
| 只从错误学，不从成功学 | Mode C 沉淀有价值的成功经验 |
| 拿建议逃避当前任务 | 先修当前问题，再提改进 |
| 动不动改 SOP | 最小杠杆优先 |

## 和其他 skill 的区别

- **vs `collaborative-thinking`**：讨论收敛用它；scope 漂/犯错/知识沉淀 → self-evolution
- **vs `debugging`**：定位 bug 用它；同类 bug 反复 → Mode B
- **vs `feat-lifecycle`**：Feature 管理用它；Scope Guard 是 feat 执行中的护栏

## 下一步

三个模式出口都一样：闭环后回到当前工作流位置。
