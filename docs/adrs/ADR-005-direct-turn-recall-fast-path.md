---
id: ADR-005
title: direct_turn 召回快链 — 同步链去 LLM critique、本地 evidence gate、专用 miss 终态
status: Accepted
feature: F042
date: 2026-07-11
approved_by: 小孙（07-11 方向拍板「现在修，要做就做好」；技术方案 = 黄仁勋×范德彪 collaborative-thinking 收敛）
supersedes: null
related: F042 AC6, F027 P13（AdaptiveRecallExecutor 原设计）
---

# ADR-005 · direct_turn 召回快链

## Context

F042 shadow 观察窗首批真实数据（preview prompt_audit，2026-07-10）证实 direct_turn 自动召回 100% 熔断走 L5 逃生舱：`recall_path=5`、`recall_satisfied=0`、`recall_critique_calls=0`、`recall_results=[]`，total_ms 20-60s。三病灶（黄仁勋诊断 + 范德彪独立复核，verdict 存 `.runtime/reviews/F042-recall-fix-debiao-verdict.md`）：

1. **评估层结构矛盾**：critique 生产实现 = spawn `claude --print` CLI（`haiku-runner.ts`，冷启+往返 20-60s），单次超时 30s、fallback 再 30s，而召回总预算 `maxTotalMs=5000`——预算内物理不可能完成一次评估。审计 `critique_calls=0` 的真实含义是「零次成功完成」。
2. **检索层语义坏死**：`sanitizeFtsQuery` 把 CJK 连续段整体 phrase 化 + 隐式 AND；trigram 表下长 phrase = 要求文档 verbatim 包含用户消息片段 → 中文自然语句恒零命中。主库 798 行索引召不出任何东西。
3. **miss 终态错位**：L2/L3 不满足必进 L5（写 wiki_events + 广播）。direct_turn 每条消息都查，正常 memory miss 被当成「需人工裁决的异常」——事件风暴。

## Decision

direct_turn（及所有同步召回链，含 wake_up）采用**无 LLM 快链**：

1. **查询编译器**：安全层（quote/注入防护）与检索策略层分离。CJK ≥3 字段→去重三字滑窗（与表 trigram tokenizer 对齐）token 间 OR；1-2 字段不进 MATCH（物理死 token，显式不支持）；显式实体信号（F/R/B 编号、wiki path、引号术语）作 MUST clause；clause 去重封顶。策略层只挂召回链——手动 `search_wiki`/`query_messages` 语义不变。
2. **本地 evidence gate**：注入判定基于命中证据（实体精确命中直通；≥2 不同 clause 命中 + coverage 下限；单常见片段 reject），毫秒级完成。
3. **专用管道** L2→gate→L3→gate→**正常 miss**（空 hits 返回，不走 L4/L5，不写 escalate 事件；只有真 backend failure 记异常）。BM25-only lexical，无同步 embedding。
4. **延迟 SLO**：p95≤200ms / p99≤500ms / 到点 fail-open 不注入；预算覆盖 backend 调用本身。
5. LLM critique 机制保留为**异步 shadow 标注器 / 离线校准器**，退出一切同步决策路径。

## Rejected Alternatives（否决记录）

| 否决项 | 理由 |
|--------|------|
| **同步 LLM critique 调快**（CLI→API 直调轻模型 1-3s） | 只把「物理不可能」变成「预算内紧张」；实时链上每条消息付 LLM 延迟+外部依赖+失败面，第一性错误——这条链上不该有 LLM。观察数据 6 行全熔断是实证。 |
| **corpus-minmax score 充当置信度 gate**（`score≥floor && hits≥1 → satisfied`） | `normalizeBm25Corpus` 是 topK 内相对归一：best 恒 1、单 hit 恒 1（`wiki-entity-fts-provider.ts:222-232`）。OR 扩召回后任何偶然噪声文档都能拿 score=1——会把「恒空」修成「恒有一个高置信噪声」，比空更伤（错误记忆注入直接毒化回复）。gate 必须基于命中证据（clause coverage/实体精确命中），排序分只管排序。 |
| **jieba 类中文分词库** | 新依赖、重；trigram 表下三字滑窗已达检索目的（德彪 SQLite 3.53 内存实测：三字滑窗 OR 命中、2 字死 token）。 |
| **沿用五级状态机 + 换假 critique** | 普通 miss 仍进 L5 造事件风暴；scenario 语义（实时 vs 批处理）应在管道分流层表达，不是在 critique 实现里伪装。 |

## Consequences

- 修完后 shadow 立刻产出真实命中/采纳数据（F042 AC1-2 度量层全复用）；inject 开启走多指标门槛（≥50 settled + ≥30 人工标注 top-1 precision ≥80% + 严重误召回 0 + p95≤200ms），由小孙人工 .env 开闸（铁律不变）。
- `recall_path`/escalate 审计语义变化：miss 不再伪装成 L5 异常；stats 与既有测试同步更新。
- 完整 LLM rerank 仍走原 out-of-scope 触发条件（30-50 条真实标注后另立项），彼时以异步/离线形态回归，不回同步链。
