# 2026-04-19 · Worktree 愿景验收基础设施讨论

**Related**: F024
**Participants**: 小孙（CVO · 真人）、黄仁勋（Claude · 主架构师）、范德彪（Codex）、桂芬（Gemini）
**Mode**: collaborative-thinking（Phase 1 独立思考 + Phase 2 三轮串行讨论）

---

## 小孙提出的问题（原话）

> "我们现在开发都在 worktree 上，我们愿景该如何验收呢"

隐含痛点：worktree 做代码隔离，但**愿景验收必须推到 dev 才能看效果**，导致 worktree 的隔离价值在最后一步失效，同时 dev 语义撕裂。

---

## Phase 1 · 独立思考要点

### 桂芬（视觉/体验视角）
- 提出"**原地验收 (In-situ Verification)**"概念：让环境/验收工具降临到 worktree，而不是代码推向共享环境
- 三维度方案：worktree-specific 运行实例 + 验收工具路径劫持 + 愿景报告就地存放
- 提出两个原始分歧点：愿景存储策略（中心化/去中心化）、验收环境生存周期（即时销毁/常驻）

### 黄仁勋（架构视角）
- 定性：现状混淆了"feature 级验收"与"愿景级验收"
- 双层架构雏形：**L1 worktree 独立 runtime** + **L2 集成 staging worktree**（多 feature 协同验收舞台）
- 核心断言：dev 语义应恢复为"只承载已验收代码"

### 范德彪（证据/流程视角）
- 引用仓库内三份证据，证明这不是新问题：
  - `docs/discussions/2026-04-14-vision-guardian-infra.md:18` — 旧问题定性为"证据通道缺失 + 开发回路原始"
  - `docs/features/F008-dev-infra-evidence-chain.md:76` — F008 当时结论"先建证据链不上阻断"
  - `multi-agent-skills/acceptance-guardian/SKILL.md:14` + `multi-agent-skills/worktree/SKILL.md:16` — 隔离原则已定义
- 提出第一性原理："**验收环境必须和待合入对象同源**"
- 原主张：worktree 自起 preview，dev 只做 merge 后 smoke

---

## Phase 2 · 串行讨论收敛过程

### 第 1 轮

- **黄仁勋**：采纳范德彪的"同源原则"作为第一性原理；与范德彪 A、桂芬"哨所"合流为 L1；但保留 L2（单 worktree preview 验不了多 feature 协同态，merge 后发现耦合回退代价高）
- **范德彪**：收回"只靠 merge 后 dev smoke"，转而偏向 L2，**但补硬约束**："L2 不能做成第二个常驻 dev，必须是一次性集成候选面，验完销毁"
- **桂芬**：撤销"去中心化愿景"提案，改为支持中心化；支持 L2；提出新提案"愿景看板 Dashboard"

### 第 2 轮

- **黄仁勋**：完全采纳范德彪的"临时集成面 ≠ 第二个 dev"护栏；对桂芬的愿景看板表态——方向对但**推后独立立项**，不纳入本次讨论产物
- **范德彪**：同意愿景看板推后；补"**L2 manifest 护栏**"——每次集成必须固化三元组（feature 列表 + commit SHA + 愿景版本），否则不可追溯
- **桂芬**：同意推后看板，同意 manifest 方案；补"MVP 可见性"要求（CLI 至少打印端口）

### 第 3 轮

- 三方一致收敛，[consensus]

---

## 最终共识

### C1 · 第一性原理
**验收环境必须和待合入对象同源**（范德彪提出，三方采纳）

### C2 · 双层架构

| 层级 | 用途 | 形态 |
|------|------|------|
| **L1 · worktree preview** | 单 feature 愿景验收 | 每个 worktree 独立端口 + 独立数据目录，acceptance-guardian 直接在这里跑 |
| **L2 · 临时集成 worktree** | 多 feature 协同愿景验收 | **一次性 · 按候选集生成 · 验完销毁**，严禁退化为第二个 dev |

### C3 · 愿景定义中心化
愿景以主仓 `.agents/vision/*.md` 为准，worktree 只出验收报告、不改验收标准。

### C4 · dev 语义归位
dev 只承载"已通过愿景验收的代码"，merge 后只做集成 smoke。

### C5 · L2 manifest 护栏（范德彪防漂移）
每次 L2 集成必须固化三元组：
- 参与的 feature/worktree 列表
- 各自绑定的 commit SHA
- 绑定的中心化愿景版本

无 manifest 则 L2 不可追溯，等于重新造污染。

### C6 · Meta 层 Dogfooding
本 feature 做完后，AC 必须**用 L1 本身验收 L1** — 这是最强的闭环证明。

---

## 推后提案

**桂芬的"愿景看板（Vision Dashboard）"** — 顶层浮动导航栏，支持在 worktree preview / staging 之间切换
- **方向认可**：观测面缺失是真问题
- **推后理由**：属于独立 UI feature（端口发现 + 导航），不是本次验收流程必要条件
- **过渡方案**：L1 实施时 CLI 输出 `worktree <name> preview: localhost:<port>` 作为零成本可观测面
- **后续**：L1/L2 跑通后单独立项讨论

---

## 撤销的分歧点

| 分歧点 | 撤销原因 |
|--------|---------|
| 愿景存储：中心化 vs 去中心化 | 桂芬撤销，三方一致采纳中心化 |
| 愿景验收触发节奏（粗问法） | 黄仁勋撤销，改写为"多 feature 协同验收在哪做" |
| 多 feature 协同在哪验：单 worktree vs L2 集成 | 三方收敛到 L2（范德彪转向 + 护栏补齐） |
| dev 只做 merge 后 smoke 能否覆盖多 feature 耦合 | 范德彪收回 |

---

## 无需村长拍板的剩余不确定性（交给 writing-plans 消化）

- **L1 工程前置**：packages/api + web 启动是否支持端口/数据目录参数化（F008 历史推测点需要验证）
- **L2 触发时机**：哪些场景必须 L2（双 feature 共享 UI 面？跨 agent 协作？）
- **L1 数据/环境生存周期**：即时销毁 vs worktree 存活期常驻 — 工程取舍，实施时再定
- **L2 数据 seed**：跑愿景用户旅程是否需要预置数据

---

## 小孙拍板结论

1. **立项 F024**：L1 + L2 一起做
2. **验收方案确认**：Dogfooding 硬门禁成立
3. **下一步**：kickoff → Design Gate（架构级 → 需小孙确认前端影响面）→ writing-plans
