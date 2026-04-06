# Feature Doc Template (F0xx)

> **用途**：创建新 Feature 聚合文件时，复制下方「模板正文」部分到 `docs/features/Fxxx-name.md`，替换占位符。
> **必填字段**：Status / Why / What / Acceptance Criteria / Dependencies
> **可选字段（轻量 Feature ≤1 Phase 可省略）**：Timeline / Review Gate / Links / Key Decisions

---

## 模板正文

```markdown
---
id: F{NNN}
title: {Feature Name}
status: spec
owner: {Owner Name}
created: {YYYY-MM-DD}
---

# F{NNN} — {Feature Name}

**Status**: spec | in-progress | done
**Created**: {YYYY-MM-DD}

## Why

{为什么要做这个 Feature？解决什么问题？}

## What

{这个 Feature 做什么？用户能感知到什么变化？}

## Acceptance Criteria

- [ ] AC1: {具体可验证的验收条件}
- [ ] AC2: {具体可验证的验收条件}
- [ ] AC3: {具体可验证的验收条件}

## Dependencies

- {依赖的其他 Feature / 外部系统 / 前置条件}
- 无依赖则写「无」

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|

## Timeline

| 日期 | 事件 |
|------|------|
| {YYYY-MM-DD} | Kickoff |

## Links

- Discussion: {讨论记录路径}
- Plan: {实施计划路径}
- Related: {关联 Feature ID}

## Evolution

- **Evolved from**: {前序 Feature ID，无则写「无」}
- **Blocks**: {被本 Feature 阻塞的 Feature ID}
- **Related**: {松耦合关联 Feature ID}
```
