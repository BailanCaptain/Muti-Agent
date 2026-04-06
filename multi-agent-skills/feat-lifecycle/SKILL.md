---
name: feat-lifecycle
description: >
  Feature 立项、讨论、完成的全生命周期管理。
  Use when: 新功能、bugfix、重构、立项、feature 完成、验收通过、讨论新功能需求。
  Not for: 代码实现（用 tdd）、review（用 requesting-review）、merge（用 merge-gate）。
  Output: Feature 聚合文件 + ROADMAP 索引 + 真相源同步。
triggers:
  - "新功能"
  - "bugfix"
  - "重构"
  - "开发任务"
  - "feat"
  - "立项"
  - "feature 完成"
  - "验收通过"
argument-hint: "[阶段: kickoff|discussion|completion] [Fxxx 或主题]"
---

# Feature Lifecycle

管理 Feature 从诞生到收尾：立项建追溯链、讨论沉淀决策、完成闭环同步。

**编排器角色**：feat-lifecycle 管理生命周期，不执行具体编码/review/merge（那些交给专门 skills）。

## 核心知识

**Feature vs Tech Debt**：小孙能感知变化 → Feature；只有开发者知道 → Tech Debt。不确定先记 TD。

**追溯链架构**：`docs/ROADMAP.md`（索引）→ `docs/features/Fxxx.md`（聚合文件，唯一入口）→ `docs/plans/` + `docs/discussions/`（详细文档）

**演化关系**：`Evolved from`（功能演进）/ `Blocks`（硬依赖）/ `Related`（松耦合）

## 立项 (Kickoff)

**触发**：小孙说"新功能"/"立项"、讨论收敛确认要做。
**不触发**：还在探索 → `collaborative-thinking`；小修补 → TD，不走立项。

### Step 0: 关联检测（防重复立项）

**分配 F 编号前，先跑关联检测**：

1. **搜索现有 Features**：
   ```bash
   grep -i "{关键词}" docs/ROADMAP.md docs/features/*.md
   ```
   同时搜对话记忆：通过 `search-memories("{关键词}")` 查找历史讨论。

2. **判定**：

| 判定结果 | 处置 |
|---------|------|
| 已有 Feature 的子任务 | **不立新号**，挂到现有 Fxxx 下 |
| 已有 Feature 的相关需求 | 标记 `Related: Fxxx`，由小孙决定合并还是独立 |
| 全新独立需求 | 继续走 Step 1 分配 F 号 |
| 太小 / 纯 enhancement | **不立项**，直接写代码 |

### Step 1-5: 正式立项流程

1. **分配 ID**：
   ```bash
   grep -E "^\| F[0-9]+" docs/ROADMAP.md | tail -1
   ```
   新 ID = 最大 + 1，三位数（F001, F002, ...）

2. **创建聚合文件** `docs/features/Fxxx-name.md`（kebab-case 文件名）

   从模板创建：复制 `multi-agent-skills/refs/feature-doc-template.md` 中「模板正文」部分，替换占位符。

   **必填**：Status / Why / What / Acceptance Criteria / Dependencies。
   轻量 Feature（≤1 Phase）可省略 Timeline / Links / Key Decisions。

3. **更新 ROADMAP.md**：在「活跃 Features」表末尾加行：
   ```
   | F042 | 名称 | spec | Owner | internal | [F042](features/F042-name.md) |
   ```

4. **关联文档**：Links 章节列出相关文档；更新这些文档的 `Related` 字段。

5. **Commit**：`docs(F042): kickoff {名称} [签名]`，body 含 What/Why

**检查**：聚合文件创建 ✓ ROADMAP 索引 ✓ 关联文档链接 ✓ 已 commit ✓

## 讨论 (Discussion)

**两种模式**：

### 采访式（默认）

小孙口述 → 一次一问澄清 → 排优先级 → 记开放问题。

**问题清单**：
- "为什么要做这个？现在怎么解决的？"
- "做完后你怎么用？"
- "最重要的是什么？什么可以后面再做？"

**Anti-anchor**：先让小孙表达完，再分析。不要一上来就给方案。

### 开放讨论

多 agent 协作时使用。触发 `collaborative-thinking`。

**结构**：背景 + 各自分析（先自己想再看别人的）+ 开放问题（按角色分组）+ 倾向性判断（透明推理链）。

明确标"这是讨论不是任务"，保护观点独立性。

### 讨论结束必须做

1. 落盘到 feature doc（含小孙原话、决策过程、优先级排序）
2. ROADMAP.md 更新 ref 链接
3. Commit：`docs: {topic} discussion update [签名]`

## Design Gate（设计确认）🔴

**Discussion → writing-plans 之间的必经关卡。设计没确认，不准开始写代码。**

按功能类型分流确认：

| 类型 | 判断标准 | 确认人 | 方式 |
|------|---------|--------|------|
| **前端 UI/UX** | 用户能看到的改动 | **小孙** | wireframe / 文字描述 → 小孙 OK 后继续 |
| **纯后端** | API/数据模型/内部逻辑 | **其他 agent** | `collaborative-thinking` 讨论达成共识 |
| **架构级** | 跨模块、新基础设施 | **agents 讨论 → 小孙拍板** | 先出方案再上报 |
| **Trivial** | ≤5 行、纯重构、文档 | 跳过 | 跳过 Design Gate |

**流程**：
1. 判断功能类型 → 选择确认路径
2. 前端：画 wireframe 或文字描述 → 发小孙 → 等 OK
3. 后端：`collaborative-thinking` → 拉相关 agent 讨论 API 契约/数据模型
4. 架构：agent 讨论 → 结论给小孙 → 小孙拍板
5. 确认产出归档到 feature doc 的 Design Decisions 章节

## 完成 (Completion)

**触发**：AC 全部打勾 + PR 合入 + review 通过。
**不触发**：只是 Phase 完成 / 只是 review 过了。

### Step 0: 愿景对照（不可跳过）🔴

AC 全打勾 ≠ 完成（AC 可能本身不完整）。先读原始 Discussion，自问三个问题：

1. **小孙最初要解决的核心问题是什么？**
2. **交付物解决了吗？**
3. **小孙用这个功能体验如何？**

如果三问有任何一个答案是"不确定"→ 和小孙确认后再继续。

### Step 1: 跨 agent 交叉验证（强制）

自己完成愿景三问后：

1. **@ 非作者非 reviewer 的 agent** 请求独立验证
   - 不要等小孙提醒，直接 @
   - 选择规则：排除实现者 + reviewer → 剩余 agent 中选一个
2. 对方独立做愿景三问 + 检查 AC
3. 对齐结论
4. 全部对齐 → 继续；不对齐 → 修改后重新验证

### Step 2: 文档闭环

1. **AC 全部 `[x]`**：未完成项先确认（完成 / 转 TD / 不需要）
2. **聚合文件更新**：`Status: done`，加 `Completed: YYYY-MM-DD`，Timeline 加收尾记录
3. **演化关系**：确认 `Evolved from` 填写；有明确后续 → 触发新 kickoff
4. **从 ROADMAP.md 活跃表移到已完成表**（聚合文件永久保留，不删）
5. **真相源同步**：所有关联文档链接正确

### Step 3: Commit

`docs(Fxxx): mark feature as done [签名]`，body 含 What/Why/Evolved from

## Quick Reference

| 阶段 | 关键动作 | 产出 |
|------|---------|------|
| Kickoff | 关联检测 → 分 ID → 建文件 → ROADMAP | `docs/features/Fxxx.md` |
| Discussion | 采访/开放 → 落盘 → 更新 ref | feature doc 更新 |
| Design Gate | 分流 → 确认（UI→小孙/后端→agents/架构→两边）| Design Decisions |
| Completion | 愿景对照 → 跨 agent 验证 → 闭环文档 | Status: done |

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 完成后才补聚合文件 | Kickoff 时就建 |
| AC 打勾就标 done，不读原始需求 | Step 0 愿景对照 |
| 自己验完就收尾 | 跨 agent 交叉验证是强制的 |
| 删了聚合文件 | 只从 ROADMAP 活跃表移除，聚合文件永久保留 |
| 不记录演化关系 | Completion Step 2 必须思考 |
| 讨论完不落盘 | 讨论结束写入 feature doc |
| 每步停下来问小孙"可以继续吗？" | 全链路自驱，只在阻塞/close 时通知 |
| 设计没确认就开始写代码 | 先过 Design Gate 再动手 |
| 后端 API 自己拍板不讨论 | 纯后端走 `collaborative-thinking` 拉 agent 讨论 |

## 下一步

- Kickoff 后 → **Design Gate**（按类型分流确认）→ `writing-plans`
- 开发完成后 → `quality-gate` → `vision-guardian` → `requesting-review`
- Review 通过后 → `merge-gate`（合入）→ 回来用 Completion 闭环
- 讨论收敛后 → `collaborative-thinking` Mode C（沉淀 ADR/规则/教训）
