---
title: Agent Wiki Handbook · 红样例（违规复制 shared-rules.md 内容）
type: rule
canonical_owner_path: wiki/rules/agent-wiki-handbook.md
slice_metadata:
  - h2: 编译规则
    inject_to: compile-LLM
  - h2: Sanitize 规则
    inject_to: sanitize-LLM
  - h2: Agent 动作手册
    inject_to: agent runtime (optional)
  - h2: Dev / human 部分
    inject_to: none
---

# Agent Wiki Handbook

> ⚠️ 本文件是 **AC-P1-6 红样例** —— 故意把 shared-rules.md 的「@ 规则」搬进 handbook，
> cross-file dedupe lint 必须报红。

## 编译规则

### 分类标准
raw drop 4 类（external-ref / concept / method / lesson）。

## Sanitize 规则

### 5 层流程
NFKC / HTML / fence / encoding / multi-pass。

## Agent 动作手册

### 你与 wiki 的关系
你是 wiki 贡献者 + 维护者。

### 协作纪律（@ 规则）

> ❌ 这一段是从 shared-rules.md 完整 copy 出来的「协作纪律」/「@ 规则」内容 ——
> handbook 不应该讲团队协作 / @ 派发，那是 shared-rules.md 的领域。

派发用 `[Call: @人名 任务描述]` 标签（F026 方案 X）—— agent 自由文本里的 `@人名`
一律不派发（避免脆弱白名单 / 动词猜测）。要让对方动起来，写 `[Call: @范德彪 review PR]`
这样的显式标签，位置无关（行首 / 句中 / 段中皆可）。前端会把标签隐藏渲染成普通 @ 蓝条，
读者看不到 `[Call:]` 字样。user 不受此约束 —— 小孙手打 `@黄仁勋 看下` 仍走老 line-start
派发，标签是给 agent 用的协议层契约。

`@` 用真实人名 —— `@黄仁勋` / `@范德彪` / `@桂芬` / `@小孙`，**不是** provider 代号、
**不是**文件路径。

## Dev / human 部分

### 设计决策历史
按 H2 切片注入不同 LLM。

### Contributor Onboarding
改编译规则 / Sanitize 规则 / Agent 动作手册 / 加新切片。
