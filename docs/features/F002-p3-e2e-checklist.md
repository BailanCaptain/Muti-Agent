# F002 P3.T4 — 手动 E2E 验收清单

> Feature：F002 Decision Board
> 分支：`feat/f002-decision-board`
> 状态：待小孙手动走查 → P3 碰头

## 前置

```bash
# 终端 A — API
cd /c/Users/-/Desktop/multi-agent-f002-decision-board
pnpm dev:api

# 终端 B — Web
cd /c/Users/-/Desktop/multi-agent-f002-decision-board
pnpm dev:web
# → http://localhost:3000
```

打开浏览器 devtools Network 面板（筛选 `ws`）+ Console。

## 场景清单（8 条）

### S1 — 单个 [拍板]（AC1 / AC3 / AC5 / AC8）

**步骤**：向范德彪 @ 一个需要决策的问题，等他回复带 `[拍板] 问题？\n- 选项A\n- 选项B`。
**期望**：
- [ ] 讨论未结束时（他还在接力/并行）不弹 modal
- [ ] A2A 完全静默约 2s 后，深墨蓝 modal 弹起（`decision.board_flush` 事件，一条）
- [ ] 选一个选项 → 提交 → modal 关闭
- [ ] chain starter thread 写入一条 user message `# 产品决策\n01. 问题 → 选项A`
- [ ] 该 thread 收到一次新的 dispatch（AC5：单点）

### S2 — 双 agent 同时 [拍板]（AC3 / AC8）

**步骤**：让范德彪 + 桂芬都在各自回复里带 `[拍板]`（不同问题）。
**期望**：
- [ ] Settle 后弹 **一个** modal，含 **两张卡片**
- [ ] 每张卡片底部 badge 显示各自 raiser（范德彪 / 桂芬）
- [ ] 没有两次弹窗

### S3 — 同题 dedupe（AC4）

**步骤**：范德彪和桂芬都在回复里带同一个 `[拍板] 数据库选型？\n- PG\n- Mongo`（问题文本一致，哪怕标点差异）。
**期望**：
- [ ] Modal 里只有 **一张卡**
- [ ] Raiser badge 同时列出范德彪 + 桂芬
- [ ] 合并后选项去重

### S4 — [撤销拍板]（AC6）

**步骤**：范德彪先写 `[拍板] Q1`，紧接下一轮回复写 `[撤销拍板] Q1`。
**期望**：
- [ ] Settle 触发后 **不弹 modal**（pending 已清空）
- [ ] 不会写 "产品暂未就..." 消息

### S5 — 跳过（"暂不回答" / ✕）（AC9 / AC10）

**步骤**：S1 或 S2 弹窗后点 ✕ 或 "暂不回答"。
**期望**：
- [ ] POST `/decision-board/respond` body 含 `skipped: true`
- [ ] Modal 关闭
- [ ] chain starter thread 写入 `# 产品决策（暂未拍板）\n产品暂未就以下问题作出决定：...\n可以基于当前讨论继续推进`
- [ ] 该 thread 收到一次 dispatch（agents 可继续跑）

### S6 — Debounce 期内再变动（AC13）

**步骤**：S1 那种场景，在 settle 2s 窗口内让另一个 agent 再 emit 一次（哪怕只是 `parallel_think` 结果）。
**期望**：
- [ ] 2s 计时器重新 re-arm
- [ ] Modal 不提前弹
- [ ] 真正静默 2s 后才一次性弹起

### S7 — MCP `request_decision` 回归（AC7）

**步骤**：让范德彪调用 MCP 工具 `request_decision` 发起一个普通投票（非 `[拍板]` 标记）。
**期望**：
- [ ] 弹的是**老的 DecisionModal**（不是深墨蓝 Board modal）
- [ ] 背后走的是 `decision.request` / `decision.resolved` 事件
- [ ] 不触发 `decision.board_flush`
- [ ] 选完 agent 侧正常拿到返回值

### S8 — F001 视觉无回归（AC11）

**期望**：
- [ ] Timeline / 消息卡片 / composer 视觉与 F001 上线后一致（没有被 F002 的样式 bleed）
- [ ] Decision Board modal 的 `z-[1000]` 不会挡住 approval modal / decision modal 的叠放层级

## 庄严感主观评分（碰头专用）

- [ ] 深墨蓝 `#0E1A2E` 背景 + 金色边框 + 金色 accent 够庄严？
- [ ] slide-up 220ms 动效节奏合适？
- [ ] 空行 / padding / 字号（02. 序号 font-serif 3xl）压得住"产品决策时刻"这种仪式感？
- [ ] "暂不回答" 语气不会让小孙觉得被绑架？

## 已由自动化覆盖（不需要手测）

- DecisionBoard dedupe / withdraw / hash 归一化（P1.T1 unit tests）
- SettlementDetector 3-AND 信号 + debounce re-arm（P1.T2 unit tests）
- ChainStarterResolver 边界（无消息 / 多 starter）（P1.T3 unit tests）
- MessageService 并入 board / flush 事件字段 / handleBoardRespond 路由（P2 message-service.test.ts）
- MCP request/respond 路径不经过 Board（P2.T5 decision-manager.test.ts）

## 下一步

全部 ✅ → 进入 **F002 P3 碰头**：演示 + 愿景三问 + AC1-AC15 核对 → merge → feat-lifecycle completion。
