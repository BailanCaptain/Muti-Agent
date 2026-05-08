---
id: ADR-002
title: A2A 协议真相源从「worklist/return-path」升级为「Call Tree + Explicit Convener + Pending Set + Join」
status: Accepted
feature: F026
date: 2026-04-23
approved_by: 小孙（Design Gate D4）
supersedes_prior_adr: null
related: ADR-003, ADR-004
---

# ADR-002 · A2A Call Tree 协议真相源

## Context

F026 Round 1 把 A2A 的症状（R-184 双消息 / 串房 / 空壳 / @ 不生效 / 不收敛）收敛到「五条不变量全漏」，但协议模型层的**真相源**一直没锁死——当时的实现用 `worklist` + `return-path` + `sessionGroupId` 三件东西拼接，最小粒度是"会话"，不是"调用"。

Round 2 讨论（2026-04-23 room 11:35，范德彪）给出代码证据：

- `packages/api/src/orchestrator/a2a-chain.ts:3-12` 只有 `parentInvocationId / rootMessageId / sessionGroupId` —— 表达不了「谁在收敛 / 还欠谁 / 这次替谁叫人」
- `packages/api/src/orchestrator/parallel-group.ts:39-70` 的 `pendingProviders / completedResults / aggregating` 其实是 join 雏形（但绑在 sessionGroup 上）
- `packages/api/src/orchestrator/settlement-detector.ts:26-68` 按 sessionGroupId 判 settle = 最小粒度是会话，不是调用树

三方视角独立收敛（Round 2 §三 强信号）：

| 视角 | 立场 | 来源 |
|---|---|---|
| 协议模型层（范德彪） | call tree + pending set + join 是权威 | room 11:35 Q1 (b) |
| UX / 前端（桂芬） | `parentCallId / rootRequester` 必须焊死在协议层 | room 11:40 + 11:43 |
| 愿景层（小孙） | 「由提出方收敛（无论过多少轮）」= call tree 语义 | Round 1 场景 1、6 |

## Decision

**A2A 协议真相源 = Call Tree + Explicit Convener + Pending Set + Join**。

### 核心字段（协议层）

每一次 A2A 调用是 `a2a_calls` 表的一行，必含：

| 字段 | 含义 |
|---|---|
| `call_id` | 本次调用唯一 ID |
| `parent_call_id` | 父调用 ID（A 叫 B，B 又叫 C → C.parent=B.call_id） |
| `root_call_id` | 整条链起点（沿 parent 追到根） |
| `issuer_id` | 谁发起了这次调用（"谁按的发送键"） |
| `convener_id` | 结果回给谁收敛（默认 = `parent.issuer`） |
| `on_behalf_of` | 替谁在问（"A 代表小孙拉 B" 场景） |
| `reply_to` | 回执地址 |
| `deadline` | 超时时刻 |
| `status` | `pending / working / done / failed / timeout / cancelled` |
| `join_set_id` | 并发兄弟调用的共享 join 桶（用于 parallel-group） |
| `envelope_version` | schema 版本号 |

### 运行时结构

- **Call Tree**：节点 = 一次 call，边 = parent_call_id 关系。tree 以 `root_call_id` 分区
- **Pending Set**：`parent_call_id` 相同 + `status ∈ {pending, working}` 的子集。parent 只有在 pending set 为空时才进入收敛
- **Join**：多子回执进入 parent 的合并逻辑（`parallel-group` 升级）
- **Explicit Convener**：`convener_id` 在 call 创建时显式指定，**不靠嵌套自动推导**。默认 = `parent.issuer`（严格分级）；显式豁免由 ADR-003 on-behalf 语义反推或 API 显式传参

### Worklist 的新定位

原 F003 `worklist / return-path` 从**协议中心降级为执行器细节**：

- 保留 R-184 根治机制：同 routeSerial 内 `worklist[++index]` 续推 ≠ 新 invocation（**I2-a 同 turn 单行 message**）
- 但 worklist 不再决定产品语义。"谁回给谁、什么时候收敛、哪个 sibling 可见"完全由 Call Tree 判定
- Phase 2 标题从「Worklist 续推」改为「Return-path → Worklist 执行器改造（同 turn 单行 message）」

## Consequences

### Positive

- (+) R-184 双消息仍可由「同 turn 单行 message」不变量（I2-a）保证，不依赖协议中心
- (+)「A 代表 caller 拉 B」与「A 为自己求助 B」两种语义通过 `issuer_id` / `convener_id` / `on_behalf_of` 三字段明确区分（这是旧实现的致命模糊）
- (+) 「不互相污染」通过 branch isolation（sibling 默认不可见，见 I9）在协议层直接实现，不靠前端兜底
- (+) 进程重启后 pending 可从 DB 恢复（I4 升级到 call tree 作用域）
- (+) 观测性：`/debug/a2a` 可视化 call tree，排障从"看 log 猜"升级为"看图"

### Negative

- (−) `a2a_calls` 表字段从 ~8 扩到 ~13，migration 成本 + 写入 I/O 略增
- (−) 旧 F003 `return-path.ts` 需并行 2 周 double-write（flag 切换）再切除
- (−) call-registry 是新核心组件，回归面广——Phase 1 必须 TDD + fuzz

### Neutral

- (=) clowder-ai 原版用 `sessionGroupId` 足够是因为 clowder 单会话不嵌套；Multi-Agent 三 agent 互相 @ 会 n 层嵌套，必须升级

## Alternatives Considered

| 选项 | 否决原因 |
|---|---|
| (a) 保留 worklist/return-path 为真相源 | 代码证据表明它**表达不了**嵌套调用的收敛归属；R-184 已证明实现层漏洞 |
| (b) sessionGroupId + 新增单个 `invocationId` 字段 | 仍是平铺结构，不能表达 parent/child；settle 仍按 session 粒度 |
| (c) 完全抄 clowder 同构 | clowder 单会话场景，不覆盖 n 层嵌套 |

## Rollout Plan

- **Phase 1**：`call-registry.ts` 骨架 + `a2a_calls` 表扩字段 migration + envelope-builder 从 call-registry 取字段
- **Phase 1 末**：双轨 flag 启动（新旧路径并行）
- **Phase 2**：废 `return-path.ts` new-invocation，改 worklist 续推作为执行器
- **Phase 2+2 周**：flag 切换，旧路径下线
- **Phase 4**：Call Tree 持久化 + STALE 扫描 + `kill -9` 恢复测试

## Verification

- Phase 1 AC：openCall / pendingOf / settle 单测全绿；fuzz 1000 层嵌套 call tree 构建无崩溃；a2a_calls 表 migration 可逆向
- Phase 2 AC：R-184 replay 绿；双轨 flag 切换期间数据一致
- Phase 4 AC：`kill -9` 重启后所有 pending call 状态可恢复，回程不重入

## References

- Round 2 讨论收敛报告：`docs/discussions/F026-design-discussion-round-2.md` §Q1 / §Q5 / §三 / §6.1
- 范德彪 Round 2 Q1-Q6 立场：room 11:35（第 29 条）
- F026 spec：`docs/features/F026-a2a-reliability-layer.md` I7 不变量
- ADR-003（@ 三层识别）：消费 `convener_id / on_behalf_of` 语义
- ADR-004（A2A 透明）：消费整个 Call Tree 作 Envelope protocol 层
