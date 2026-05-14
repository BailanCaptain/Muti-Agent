---
title: Agent Wiki Handbook · 绿样例（用 cross-ref，不复制 shared-rules.md 内容）
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

> ✅ 本文件是 **AC-P1-6 绿样例** —— 涉及团队协作 / @ 规则的内容用 cross-ref 指回
> shared-rules.md 真相源，不复制内容到本文件。cross-file dedupe lint 必须绿。

## 编译规则

### 分类标准
raw drop 4 类（external-ref / concept / method / lesson）。

## Sanitize 规则

### 5 层流程
NFKC / HTML / fence / encoding / multi-pass。

## Agent 动作手册

### 你与 wiki 的关系
你是 wiki 贡献者 + 维护者。

### 协作纪律（Collaboration）

@ 派发 / Call 标签 / 真实人名 等团队协作规则的真相源在 [shared-rules.md § 协作纪律](../../../multi-agent-skills/refs/shared-rules.md#%E5%8D%8F%E4%BD%9C%E7%BA%AA%E5%BE%8B%EF%BC%88collaboration%EF%BC%89)，
本文件不重复。涉及 wiki 操作时遇到 @ 升级，按 shared-rules 走。

## Dev / human 部分

### 设计决策历史
按 H2 切片注入不同 LLM。

### Contributor Onboarding
改编译规则 / Sanitize 规则 / Agent 动作手册 / 加新切片。
