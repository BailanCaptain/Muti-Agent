---
id: F031
title: WS 消息可靠性：sessionGroup seq + epoch + gap 检测/catch-up（F-B）
status: spec
owner: 黄仁勋
created: 2026-06-13
---

# F031 — WS 消息可靠性：sessionGroup seq + epoch（F-B）

> 排队中：clowder-ai 借鉴批次第 2 个，F030 合 dev 后启动。
> 参考：clowder-ai `packages/api/src/infrastructure/websocket/ThreadSequencer.ts`（单实例 in-memory，明确拒绝分布式 sequencer）。

## Why

WS 重连窗口内丢失的事件目前**不可检测**——表现为"这条消息怎么没显示/状态不对"，排查无从下手。德彪核实 clowder 实现属实：seq 单调号 + 启动 epoch UUID + 客户端 gap 检测自动 catch-up，可消灭这一整类沉默 bug。

## What

- 服务端：per-**sessionGroup**（⚠ 不是 thread——我们 WS 按 sessionGroupId 路由，ws.ts:58，德彪 OQ1 修正）单调 seq + 进程启动 epoch UUID，注入每条广播事件
- 客户端：比对 (epoch, seq)，发现缝隙触发 catch-up；epoch 变化（服务重启）重置 + 全量拉取（复用现有重连逻辑 client.ts:76）

## Acceptance Criteria（骨架，立项细化）

- [ ] AC1: 服务端 sequencer per-sessionGroup 注入 seq + epoch
- [ ] AC2: 客户端 gap 检测 → catch-up 请求 → 成功 ACK；失败重试有上限和降级（全量拉取）
- [ ] AC3: epoch 变化正确触发重置，不误报 gap
- [ ] AC4: 模拟丢包/重启的集成测试

## Dependencies

- 无硬依赖

## Design Decisions（预置约束）

| 决策 | 结论 | 原因 |
|------|------|------|
| 序列域 | sessionGroup-scoped | 我们 WS 订阅按 sessionGroupId 路由非 threadId（德彪实证 ws.ts:58 / page.tsx:109） |
| 架构 | 单实例 in-memory，不做分布式 | 照搬 clowder KD-9 反 over-engineering 结论 |

## Evolution

- **Evolved from**: 无
- **Related**: F030（同批次）
