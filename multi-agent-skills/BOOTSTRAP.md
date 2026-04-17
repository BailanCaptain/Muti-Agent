# Multi-Agent Skills Bootstrap

<EXTREMELY_IMPORTANT>
你已加载 Multi-Agent Skills。路由规则的**单一真相源**是 `multi-agent-skills/manifest.yaml`；这份文档是压缩目录，帮你快速选对 skill 后再按需 Read 对应 `SKILL.md` 全文。

## Skills 列表（15 个）

### 开发流程链（主干）

```
feat-lifecycle → Design Gate → writing-plans → worktree → tdd
    → quality-gate → acceptance-guardian → requesting-review → receiving-review
    → merge-gate → feat-lifecycle(完成)
```

### 所有 Skills（按触发场景查表）

| Skill | 触发场景 | Slash | Next |
|-------|---------|-------|------|
| `feat-lifecycle` | Feature 立项 / 讨论 / 完成的全生命周期 | `/feat` | `writing-plans` |
| `writing-plans` | 将 spec/需求拆分为可执行的分步实施计划 | `/plan` | `worktree` |
| `worktree` | 创建 Git worktree 隔离开发环境 | — | `tdd` |
| `tdd` | Red-Green-Refactor 测试驱动开发 | `/tdd` | `quality-gate` |
| `quality-gate` | 开发完自检（愿景对照 + spec 合规 + 验证命令） | `/gate` | `acceptance-guardian` |
| `acceptance-guardian` | 零上下文独立验收（feature AC / bug 复现） | `/guardian` | `requesting-review` |
| `requesting-review` | 请求 reviewer 审查（自检通过后发起） | `/request-review` | `receiving-review` |
| `code-review` | 严格代码审查（bug / 风险 / 回归 / 边界 / 缺失测试） | `/review` | — |
| `receiving-review` | 收到 review 反馈，Red→Green 修复 | — | `merge-gate` |
| `merge-gate` | 门禁检查 → PR → squash merge → 清理 | `/merge` | `feat-lifecycle` |
| `cross-role-handoff` | 跨角色交接 / 传话，输出五件套 | `/handoff` | — |
| `collaborative-thinking` | Brainstorm / 多 agent 讨论 / 讨论收敛 | `/think` | — |
| `debugging` | 系统化 bug 定位：根因调查 → 假设验证 → 修复 | `/debug` | `quality-gate` |
| `self-evolution` | Scope Guard / 流程改进 / 知识沉淀 | `/evolve` | — |
| `writing-skills` | 创建或修改 Multi-Agent skill 的元技能 | `/write-skill` | `quality-gate` |

### 参考文件（`refs/`，按需读取）

| 文件 | 内容 |
|------|------|
| `refs/shared-rules.md` | 三人共用协作规则（家规单一真相源） |
| `refs/feature-doc-template.md` | Feature doc 模板（聚合文件结构） |
| `refs/bug-diagnosis-capsule.md` | Bug 诊断胶囊模板（debugging 前置填写） |

## 关键规则

1. **Skill 适用就必须加载，没有选择** — 见 `refs/shared-rules.md` 铁律 6
2. **完整流程链**：`feat-lifecycle → writing-plans → worktree → tdd → quality-gate → acceptance-guardian → requesting-review → receiving-review → merge-gate`
3. **四条铁律**：数据神圣不可删 / 进程自保 / 配置不可变 / 网络边界（详见 `refs/shared-rules.md`）
4. **共用规则在 `refs/shared-rules.md`**，不在各 agent 文件里重复
5. **Design Gate 不可跳过**：UI → 小孙确认 / 纯后端 → agents 讨论 / 架构级 → agents 讨论 + 小孙拍板

## 使用方式（三 CLI 加载方式差异）

| 角色 / CLI | 挂载点 | Discovery 机制 |
|-----------|-------|---------------|
| **黄仁勋（Claude CLI）** | `.claude/skills/` | 原生 discovery：启动时扫目录 + 读 SKILL.md frontmatter 自动注入 |
| **范德彪（Codex CLI）** | `.agents/skills/` | 项目级约定扫描；SKILL.md 按需读取 |
| **桂芬（Gemini CLI）** | `.gemini/skills/` | 项目级约定扫描；SKILL.md 按需读取 |

三个挂载点由 `scripts/mount-skills.sh` 维护，`pnpm check:skills` 校验 drift（dangling / orphan / BOOTSTRAP 不同步均为 error）。

## 新增 / 修改 skill 的流程

1. 在 `multi-agent-skills/{name}/` 创建 `SKILL.md`
2. 在 `manifest.yaml` 添加路由条目（必填 `description` / `triggers` / `agents`）
3. **本文件 BOOTSTRAP.md 的 Skills 列表表也要加一行**（否则 `pnpm check:skills` 会报 `bootstrap-missing-skill` error）
4. 运行 `pnpm mount-skills` 重建三挂载点（已有则幂等）
5. 运行 `pnpm check:skills` 验证

## 删除 skill 的流程

1. 从 `multi-agent-skills/{name}/` 删除 skill 目录
2. 从 `manifest.yaml` 删除对应条目
3. 从本文件 BOOTSTRAP.md 的表格删除对应行
4. 运行 `pnpm mount-skills:prune` 清理三挂载点的 dangling symlink
5. 运行 `pnpm check:skills` 验证

---

**IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.**

</EXTREMELY_IMPORTANT>
