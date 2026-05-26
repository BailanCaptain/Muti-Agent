# Phase 3 6 CONDITIONAL_PASS 升 PASS 映射矩阵

> **真相源**: `docs/plans/F027-phase4-implementation-plan.md` §11 (line 417-430)
> **目的**: Phase 3 留下的 6 项浏览器实测 BLOCKED → 在 Phase 4 walkthrough/evidence pack 收稿期间逐项升 PASS
> **评判规则**: 每条 P3 AC 全 evidence 集齐 → 升 PASS；任一 evidence 缺 → 保持 CONDITIONAL_PASS（不可 blanket）

---

## 矩阵 (6 项)

| Phase 3 AC | 原 verdict | 升级路径 P4 AC | walkthrough step | evidence 收集要求 | 当前状态 |
|---|---|---|---|---|---|
| **AC-P3-1** StatusPanel 拖宽 360-1200px ≥50fps + reload ±1px | CONDITIONAL_PASS (browser fps + reload 像素 BLOCKED) | 间接 (无对应 P4 AC) | Week 4 Day 18 walkthrough 启动时手测拖宽 | `evidence/phase3/AC-P3-1/screenshots/` 加：拖宽 360→1200 reload 后像素一致截图 (前后对比) | ⏳ 待 walkthrough |
| **AC-P3-2** 5-tab 切换 scroll position 保持 ±10px | CONDITIONAL_PASS (browser scroll ±10px BLOCKED) | 间接 (无对应 P4 AC) | walkthrough 三场景全程 tab 切换 | `evidence/phase3/AC-P3-2/screenshots/` 加：tab 切换前后 scroll position 一致截图 (前后对比 + scrollTop 数值) | ⏳ 待 walkthrough |
| **AC-P3-3** Prompt Inspector 7 块全非空 | CONDITIONAL_PASS (真数据依赖 P3-9 + DB schema) | AC-P4-9 d + AC-P4-8 | 场景 1 step 1.5 (/ingest 后) + 场景 3 step 3.3-3.4 (Coverage 触发) | `evidence/phase3/AC-P3-3/screenshots/` 加：inspector 7 块非空 (含 recall_path 真数据) + 第 8 块 Coverage section | ⏳ 待 walkthrough + AC-P4-9 d 落地 |
| **AC-P3-6** IngestModal 3 入口 | CONDITIONAL_PASS (3 入口 browser modal BLOCKED) | AC-P4-9 d (DB seed 后真数据) | 场景 1 step 1.1-1.4 走入口 A (拖) + 入口 B ([+ Drop]) + 入口 C (`/ingest`) | `evidence/phase3/AC-P3-6/screenshots/` 加：3 入口分别触发 IngestModal 截图 (3 张) | ⏳ 待 walkthrough |
| **AC-P3-8 b** Inspector unresolved UI | CONDITIONAL_PASS (推 Phase 4) | **AC-P4-9 c** | 场景 3 step 3.4-3.5 | `evidence/phase3/AC-P3-8/screenshots/` 加：Coverage section 非空 + click trigger alert (Day 13 占位; 真 supersede/reject UI 归 **RESIDUAL-DEBT B8**) | ⏳ 待 walkthrough；RESIDUAL-DEBT B8 已记 |
| **AC-P3-9** Adaptive Recall wiring (server.ts:239 noop ready-for-Phase-4) | CONDITIONAL_PASS (boot wire 验证 BLOCKED) | **AC-P4-8** | 场景 1 step 1.5 真房间 recall 触发 | `evidence/phase3/AC-P3-9/screenshots/` 加：inspector recall_path + DB `prompt_audit` 9 字段真写入 + boot log `enabled=true, levels=[2,3,4,5]` + AC-P4-8 evidence pack 双 judge artifact | ⏳ 待 walkthrough + AC-P4-8 evidence pack 收齐 |

---

## 升 PASS 操作清单 (Week 5 Day 23 walkthrough 结束后执行)

每条 AC 升 PASS 时**逐项核对**：

### AC-P3-1
- [ ] `screenshots/before-resize-360px.png` (拖前 360px)
- [ ] `screenshots/after-resize-1200px.png` (拖到 1200px)
- [ ] `screenshots/after-reload-1200px.png` (reload 后 ±1px)
- [ ] 修改 `evidence/phase3/AC-P3-1/result.json`：
  ```
  "browser_verification": "BLOCKED" → "PASS (walkthrough Day 18 截图核验通过)"
  "review_status": "GO (Day 11 r2 confirmed)" 不变
  ```

### AC-P3-2
- [ ] 在 walkthrough 三场景脚本中每次切 tab 截图前后对比 (≥3 张前后对)
- [ ] 修改 `evidence/phase3/AC-P3-2/result.json` 同上

### AC-P3-3
- [ ] 场景 1 step 1.5 后 inspector 7 块截图 (1 张)
- [ ] 场景 3 step 3.3-3.4 后 inspector 第 8 块 Coverage 截图 (1 张)
- [ ] DB 查 `prompt_audit` 表有非空 row (sqlite3 query result 存 `logs/db-prompt-audit.json`)
- [ ] 修改 `evidence/phase3/AC-P3-3/result.json` 同上

### AC-P3-6
- [ ] 入口 A (拖文件到 composer) → IngestModal 截图
- [ ] 入口 B ([+ Drop] 按钮) → IngestModal 截图
- [ ] 入口 C (`/ingest <file>` slash command) → IngestModal 截图
- [ ] 修改 `evidence/phase3/AC-P3-6/result.json` 同上

### AC-P3-8 b
- [ ] Coverage section unresolved 列表非空截图
- [ ] click [Confirm] → window.alert 截图 (Day 13 占位)
- [ ] supersede/reject 真 UI follow-up note 引用 `docs/features/F027/evidence/phase4/F027-RESIDUAL-DEBT.md` 类别 C C3.1 项（原 F028-1，2026-05-26 撤 F028 后重分类）
- [ ] 修改 `evidence/phase3/AC-P3-8/result.json` 同上

### AC-P3-9
- [ ] /ingest 后 inspector recall_path 字段截图 (非 null)
- [ ] DB query `prompt_audit` 9 字段 (recall_levels / recall_path / recall_decision / 等) 真写入 → `logs/db-prompt-audit.json`
- [ ] API server boot log 含 `[AdaptiveRecallCoordinator] enabled=true, levels=[2,3,4,5]` → `logs/api-server-boot.log`
- [ ] AC-P4-8 evidence pack 收齐 (j1/j2/arbitration if needed) → `evidence/phase4/AC-P4-8/` 引用为 cross-ref
- [ ] 修改 `evidence/phase3/AC-P3-9/result.json` 同上

---

## 升 PASS 总条件 (Phase 4 终结 gate 之一)

per plan line 188:
> Week 5 r1 review GO 条件 = Phase 4 终结条件 = 8 AC 全 PASS (或明示推 F028 的 CONDITIONAL_PASS) + **Phase 3 6 CONDITIONAL_PASS 全升 PASS (按 §11 矩阵)** + walkthrough 三场景小孙签字 + evidence pack 完整。

任何一条 P3 AC 缺 evidence → Phase 4 不能合 dev。

---

## 当前进度

- ✅ 映射矩阵文档生成 (本文件) — Week 5 Day 21
- ⏳ 待 walkthrough 执行 (Week 4 Day 18-20 推到 Week 5 Day 22 小孙手测)
- ⏳ 待 evidence 收集 + 6 个 result.json 改 verdict
- ⏳ 待 Phase 4 8 AC 收尾 → 全 PASS 后合 dev
