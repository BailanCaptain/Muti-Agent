# F027 → F028 Follow-up Backlog

> **真相源**: F027 Phase 4 plan v5 §1.1 Out of Scope + §6 O8 + 各源码内 `推 F028` 注释 (10 处, 见末尾)
> **目的**: Phase 4 严守 O8 不蔓延; 此 backlog 记录所有"明示推 F028"的项, 供 F028 立项时直接 picking
> **建立时间**: Week 5 Day 22 (Phase 4 收稿阶段)

---

## 推 F028 项总览 (10 项)

| # | 项目 | 类别 | 来源 | F027 占位状态 | F028 立项工作量预估 |
|---|------|------|------|---------------|----------------------|
| **F028-1** | 真 supersede / reject UI (Inspector Coverage section) | 写型 UI | plan §1.1; prompt-inspector-tab.tsx:44-45,442 | Day 13 占位: click → window.alert | 1-2 周 (新 endpoint + DecisionRef→draftPath 映射 + Modal) |
| **F028-2** | 写型 rollback (真改 wiki 文件 rollback) | 写型 backend + UI | plan §1.1 line 80; O5 拍 C | Phase 4 仅 read-only preview (RollbackPreviewModal 不写盘) | 2 周 (CAS / lease / fencing / 二次审计 / wiki_events action='rollback' / 并发 promote 拒绝测试) |
| **F028-3** | composer slash menu 4 写命令启用 (`/promote` `/demote` `/series` `/rollback`) | UX evaluate | plan §1.1 line 81; §6 O8 | 4 items 已加但 disabled | 1 周 (evaluate "命令面板原意 V16.5 line 2539-2545 vs 右侧面板按钮入口" 用户偏好 → 启用 + UX 完善) |
| **F028-4** | promote-only memory_preflight | 写型 backend | plan §1.1 line 79; §6 O8 | 未实现 | 1-2 周 (V16.5 划走的 5 项之一) |
| **F028-5** | sessions ledger | 写型 backend | plan §1.1 line 79; §6 O8 | 未实现 | 1-2 周 (V16.5 划走的 5 项之一) |
| **F028-6** | Adaptive Recall Level 6 | 写型 backend | plan §1.1 line 79; §6 O8 | F027 Level 5 escalate 已落 (P3-9 c); Level 6 推 F028 | 1-2 周 (V16.5 划走的 5 项之一; 复用 Level 5 sink 模式) |
| **F028-7** | Prompt Inspector 升级 | UI | plan §1.1 line 79; §6 O8 | F027 Day 13 加了 Coverage 第 8 块占位 | 1 周 (V16.5 划走的 5 项之一; 具体升级点待 V16.5 line 重读) |
| **F028-8** | WarningsTab "解决" / 删除 / mark resolved 按钮 | 写型 UI | warnings-tab.tsx:24 | Day 17 仅 list 显示, 无操作按钮 | 1 周 (后端 endpoint + UI button + wiki_events action='warning_resolved') |
| **F028-9** | KB tab markdown 表格 entity-level parse + multi-select | UI | wiki-meta.ts:23 | Day 17 仅 index .md path/title 显示 | 1 周 (parse markdown 表格 row → entity 列表; multi-select → BatchPromoteModal 复用) |
| **F028-10** | EmbeddedWikiRecord boot load + 多房间并行 ingest 压测 | 性能/scale | production-recall-executor-deps.ts:36; plan §1.1 line 83 | Phase 4 单 R-001 房间 single record load | 2 周 (multi-room concurrency lease 测试 + EmbeddedWikiRecord cold-start load) |

---

## 推 F028 详情 (按来源分类)

### A. plan §1.1 Out of Scope (5 项明示)

```
F028 范围:
- promote-only memory_preflight    → F028-4
- sessions ledger                  → F028-5
- Adaptive Recall Level 6          → F028-6
- Prompt Inspector 升级            → F028-7
- 写型 rollback                    → F028-2
```

加上小孙 Q2 拍的:
- composer slash menu 4 写命令启用 → F028-3
- 多房间并行 ingest 压测 → F028-10 (后半)

### B. 源码 `推 F028` 注释 (5 处, 4 个 feature)

```
prompt-inspector-tab.tsx:44-45,442,447,473   → F028-1 (supersede/reject UI)
warnings-tab.tsx:24                          → F028-8 (warnings 解决按钮)
wiki-meta.ts:23                              → F028-9 (KB markdown parse)
production-recall-executor-deps.ts:36        → F028-10 (前半: EmbeddedWikiRecord boot)
promote-modal.tsx:39                         → F028-3 (slash menu trigger 配合)
```

### C. plan §11 Phase 3 升 PASS 引用 (1 项)

```
AC-P3-8 b Inspector unresolved UI: Day 13 占位 click → alert; 真 supersede/reject UI 推 F028
```

即 F028-1, 已计。

---

## F028 立项优先级建议

```
P0 (核心写型功能, F027 留下硬阻塞):
- F028-1 supersede / reject UI       (Inspector Coverage 闭环)
- F028-2 写型 rollback              (rollback 不能 read-only forever)

P1 (V16.5 划走的 5 项):
- F028-4 memory_preflight
- F028-5 sessions ledger
- F028-6 Adaptive Recall Level 6
- F028-7 Prompt Inspector 升级

P2 (UX evaluate / 性能):
- F028-3 composer slash menu 4 写命令
- F028-8 WarningsTab 解决按钮
- F028-9 KB markdown parse + multi-select
- F028-10 多房间压测 + EmbeddedWikiRecord boot
```

F028 plan 立项时按此 backlog 拆 phase: P0 (2 项) → P1 (4 项) → P2 (4 项), 共 ~10-12 周。

---

## F027 Phase 4 严守 O8 已审视

per plan §6 O8 (line 283):
> F028 边界 严守不做; 命令面板 4 写命令 + 写型 rollback + memory_preflight / sessions ledger / Level 6 / Prompt Inspector 升级全部 F028

per plan §7 (line 293):
> F028 边界扯不清 风险: AC scope 蔓延 → O8 严守 + 任何"顺手"PR 必须升级小孙

Phase 4 Week 1-4 实施全程未越界 (源码 10 处 `推 F028` 注释全部为 placeholder + 注释, 无暗藏实现).

---

## 配套引用

- **Phase 3 升 PASS 矩阵**: `PHASE3_UPGRADE_MAPPING.md` (AC-P3-8 b 等条目引本 backlog)
- **plan**: `docs/plans/F027-phase4-implementation-plan.md` §1.1 / §6 O5 O8 / §7
- **V16.5 spec**: `docs/plans/V16.5-final.md` (line 2539-2545 命令面板原意; line 2563-2564 Series 字段)
