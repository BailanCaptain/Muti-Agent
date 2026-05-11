# F026 深度评审 — 由黄仁勋（Claude）独立完成

> **触发**：小孙 2026-05-08 拍 audit-v4 时质疑"你不得自己先评审一下 F026 吗"——我承认 audit-v4 把 F026 当黑盒，按 commit msg 推断结论。本报告是补做的独立深审。
>
> **范围**：F026 944b7b1（149 commits squash，2026-05-08 合 dev）schema / 核心 Registry / mention-router / Envelope / ADR-002/003/004 / 11 不变量证据 / 测试覆盖。
>
> **方法**：参照 audit-v3 对其他 8 个 done feature 的标准（line-level 代码引用 + 测试证据 + 设计文档对账）。
>
> **总评**：✅ **高质量落地**。设计严谨，算法精良，测试覆盖到位。但有 **3 处真瑕疵 + 4 处需关注点** 需小孙知情。

---

## 1. 设计层评审 — ADR-002/003/004

### 1.1 ADR-002 Call Tree 协议真相源 ✅

**设计依据**（`docs/adrs/ADR-002-a2a-call-tree-truth-source.md` 117 行）：
- Round 1 失败原因清晰：worklist + return-path + sessionGroupId 拼接，最小粒度 = "会话"，不是"调用"
- 三方独立收敛证据：协议模型层（范）+ UX/前端（桂芬）+ 愿景层（小孙）— 这是**罕见的强信号**
- 11 字段定义完整（call_id / parent_call_id / root_call_id / issuer_id / convener_id / on_behalf_of / reply_to / deadline / status / join_set_id / envelope_version）

**评价**：✅ Decision 充分，Alternatives Considered 明确否决三个备选（worklist 真相源 / 单 invocationId / clowder 同构）。Rollout Plan 4 Phase 节奏合理。

### 1.2 ADR-003 三层 fail-closed mention 识别 ⚠️ Amended

**设计依据**（192 行）：
- Layer 1 hard-negative AST masking（fenced code / inline code / blockquote / table / emphasis）
- Layer 2 hard-positive 行首 @ + 动作动词
- Layer 3 gray-zone 默认不派 + log

**Amended 原因**（F026 closing log 2026-05-08）：
- "ADR-003 的 50 动词白名单已被方案 X · `[Call:]` 强契约取代**失去对象**"
- ADR frontmatter status: Amended（小孙拍"改 ADR 不改实现"）

**评价**：⚠️ **设计漂移真实存在**。ADR-003 三层模型在 P3 被方案 X（`[Call:]` 显式标签）实质替换。文档跟代码已不完全对账。但实施层的 mention-router.ts 仍保留 Layer 1 hard-negative masking + on-behalf 反推（这部分还活）—— 不是空壳。

### 1.3 ADR-004 A2A 对 agent 透明 ✅

**设计依据**（302 行）：
- agent 一字未填（envelope 全部由 call-registry / 上下文服务推导）
- β/γ 双路径（β = 日常对话 task='conversation' / γ = cross-role-handoff skill 模板）
- DisplayMode 三态（inline / nested / background）

**CI guard**：
- ✅ `scripts/ci/check-adr-004-content.ts`
- ✅ `scripts/ci/check-adr-004-diff.sh`
- ✅ 配套测试 4 case

**评价**：✅ 唯一一个有完整 CI guard 的 ADR。

---

## 2. Schema 层评审 — `a2a_calls` + `a2a_worklists`

### 2.1 `a2a_calls`（13 字段 + 4 索引）✅

| 评审维度 | 结论 |
|---|---|
| 字段完整性 | ✅ 13 字段 cover protocol 层（11 必填 + envelope_version + sessionGroupId）+ created_at/updated_at |
| Status state machine | ✅ pending → working → {done\|failed\|timeout\|cancelled}（CHECK enum 强约束）|
| 索引 | ✅ parent / root / (status,deadline_at) 复合 / sessionGroup — 适合 timeoutScan / pendingOf / getTree / 房间聚合 |
| **CAS 实现** | ✅ status-based conditional UPDATE（`WHERE status = 'pending'` / `WHERE status IN ('pending','working')`）— 干净，无 race |
| **缺失字段** | ⚠️ **没有 result / error 字段** — failed/timeout 时 reason 在 messages.retry_reasons / agent_events，跨表查 |
| **缺 CAS version** | ✅ 不需要 — status 字段本身就是 CAS guard |
| **缺外键** | ⚠️ call_id ↔ parent_call_id ↔ root_call_id 自身可加 FK 但没设；sessionGroupId 无 FK to session_groups。**应该是 deliberate**（避免 cascade delete 影响协议状态），但 V16.5 章节 4 reference 时要知道 a2a_calls 是"半独立"的 |

### 2.2 `a2a_worklists`（10 字段 + FK + 2 索引）✅

| 评审维度 | 结论 |
|---|---|
| 树形 FK | ✅ `FOREIGN KEY (parent_worklist_id) REFERENCES a2a_worklists(worklist_id)` 自引用 |
| Status enum | ✅ active / settled（CHECK 强约束）|
| settle 不变量代码 | ✅ tryCascadeSettle 算法精良（见 §3.2）|
| **items JSON 无 schema 约束** | ⚠️ items 是 TEXT (JSON)，markItemStatus 依赖 JSON.parse + index — **schema 破坏的话越界报错**，但 register 时 items 已校验 non-empty |
| **缺 deadline 字段** | ⚠️ worklist 没自身 deadline，依赖 parent_call.deadline — 设计一致，但 timeout 扫描走 a2a_calls 不走 a2a_worklists |

---

## 3. 核心 Registry 评审

### 3.1 CallRegistry（398 行）✅

**实读 packages/api/src/orchestrator/call-registry.ts:143-289**：

| 方法 | 评价 |
|---|---|
| `openCall` (line 143-193) | ✅ 5 项必填校验 + parent 反查 root_call_id（防悬挂）+ 默认 status='pending' + emitPendingChange WS 广播 |
| `advance` (line 199-211) | ✅ CAS：`WHERE status = 'pending'` (changes=1 才算)；非法 target 直接 throw（fail-fast）|
| `settle` (line 217-229) | ✅ CAS：`WHERE status IN ('pending','working')`（终态后调是 noop，幂等）|
| `pendingOf` / `getTree` (line 231-247) | ✅ rowid tiebreaker（防同 ms ORDER BY 不稳定，P13 修）|
| `timeoutScan` (line 265-289) | ✅ **范德彪 review#2 P1 修复后**：双档（working past deadline + pending without active worklist），排除 root call + 被 active worklist 承载的 child（避免误判合法等待）|
| `emitPendingChange` (line 100-141) | ✅ review#4 fix：SELECT-then-UPDATE 后逐个 emit（避免 batch UPDATE 不 emit 导致前端拿不到 timeout 状态）|

**评价**：CAS 设计干净，无 race。timeoutScan 的双档判定是真实修复（不是 commit msg 装的）。

### 3.2 WorklistRegistry（241 行）✅✅

**实读 packages/api/src/orchestrator/worklist-registry.ts:209-240** — `tryCascadeSettle` 算法：

```typescript
// bottom-up 递推 settle
while (cursorId && depth < MAX_DEPTH) {
  if (visited.has(cursorId)) break       // 防环
  visited.add(cursorId)
  depth++
  const self = this.get(cursorId)
  if (!self || self.status !== "active") break
  
  const itemsAllDone = self.items.every((it) => it.status === "done")
  if (!itemsAllDone) break               // 不变量 1: items 全 done
  
  const children = this.findChildWorklists(cursorId)
  const childrenAllSettled = children.every((c) => c.status === "settled")
  if (!childrenAllSettled) break         // 不变量 2: 子 worklist 全 settled
  
  if (!this.settle(cursorId)) break      // CAS 撞车（并发场景）→ 退出
  
  settled.push(cursorId)
  cursorId = self.parentWorklistId       // 上推 parent
}
```

**评价**：✅ **论文级算法**。
- 双不变量精确（items 全 done **AND** children 全 settled）
- 防环：visited Set + MAX_DEPTH=50
- 防并发撞车：CAS 失败立即退出（幂等友好）
- 不触发续推派发（职责分离 — 续推归 executor）

**唯一不足**：tryCascadeSettle 不通过单事务包裹（每次 settle 是独立 UPDATE），SQLite autocommit 模式下中间崩溃可能留 child settled / parent active 中间状态。但 **再跑一次幂等收敛**（CAS 重新跑会接着 settle parent），可接受。

### 3.3 A2ALifecycleService（126 行）✅

| 方法 | 评价 |
|---|---|
| `openRootCall` | ✅ user-self 收发（issuer/convener/replyTo 全 = user alias），parent=null → root |
| `openCall` (child) | ✅ thin wrapper，convener/replyTo 默认 = issuer |
| `advance` / `settle*` | ✅ defensive contract：callId === undefined 全 noop（关键 — 不传 callId 不能让代码崩）+ 异常吞掉避免影响 turn loop |

**观察**：settle 只传 status，**没有 reason payload**。failed/timeout/cancelled 的具体原因要查 messages.retry_reasons / agent_events.payload。**不算缺陷**，但 V16.5 reference a2a_calls 时要知道 reason 不在表内。

### 3.4 A2AChainRegistry（50 行）✅

**in-memory Map**，存 invocationId → entry（含 parentInvocationId / rootMessageId / senderAlias / triggerMessageId 等 render-only 字段）。**不持久化**（render only，重启丢失可接受）。

---

## 4. mention-router 三层评审（688 行）✅✅

实读 packages/api/src/orchestrator/mention-router.ts:75-519：

### 4.1 Layer 1 hard-negative masking（line 75-144）✅✅

**覆盖**：fenced code blocks（```/~~~）/ inline code / blockquote（^>）/ table rows（^|...|）

**精细之处**：
- ✅ UTF-16 code unit 索引（不是 codepoint）— emoji surrogate pair 不错位
- ✅ Line-level state machine 处理 fence 嵌套
- ✅ Inline code 在 fence-masked 输出上检测（避免 fence 内 backtick 误识别）

### 4.2 Layer 2 hard-positive line-leading（line 44-57）✅

**正则**：`(?:^|\n)[\s*_~]*@<alias>(?=$|[\s*_~:,...])`
- ✅ 行首 + Markdown emphasis prefix（**@X** / *@X*）
- ✅ Terminator 包含中文标点（，。！？；：）

### 4.3 on-behalf 反推（line 432-468）✅

**4 类信号**：
1. `（仅 X 参考）` → on_behalf_of=X，convener 不转移
2. `帮/替/代/为 X 和/与 Y` → fail-closed null（多主语冲突）
3. `帮/替/代/为 X` → on_behalf_of=X（self pronoun → "self"）
4. `给 X 看/瞧/评/过目` → on_behalf_of=X，convener 不转移

**评价**：✅ Fail-closed 在多主语冲突时立即返回 null。

### 4.4 MentionRateLimiter（line 375-403）✅

- ✅ per-message dedupe（防同消息重复 @）
- ✅ per-session+source+target 30s 滑动窗口（**R-085 修复加 sessionGroupId**，避免跨房间互拒）

### 4.5 方案 X · Call Tag 解析（line 521+）✅

- ✅ 严格 `[Call:` 大小写敏感
- ✅ 标签内不跨行
- ✅ 复用 maskHardNegativeRanges
- ✅ 拒绝 emphasis 包裹（`**[Call: @X]**` 不识别）
- ✅ alias 表内必填（外部名字直接丢）

### 4.6 `resolveDispatchMentions` assistant role guard（line 487-519）✅

- ✅ `if (options.role === "assistant") return []`（assistant 自由文本 @ 一律不派发，只走 [Call:] 通道）

---

## 5. Envelope 双层评审（116 行）✅

实读 packages/api/src/orchestrator/envelope-builder.ts:50-116：

### 5.1 双路径

| 路径 | 用途 | task 字段 | 评价 |
|---|---|---|---|
| **β** buildBetaEnvelope | 日常对话 | `task='conversation'`，input.source_message = agent 原文整段 | ✅ 简单直接 |
| **γ** buildGammaEnvelope | cross-role-handoff skill | task 来自 skill 模板 | ✅ task='conversation' fail-closed throw |

### 5.2 双层结构 ✅

- **protocol 层**：8 字段（call_id / parent_call_id / root_call_id / issuer_id / convener_id / on_behalf_of / reply_to / deadline）— 全部从 call-registry 取
- **task 层**：5 字段（task / input / expected_output / constraints / context / render）

### 5.3 DisplayMode 三态 ✅

- `inline`（root call 用）
- `nested`（child call 用，basaed on parentCallId）
- `background`（packages/shared/src/a2a-envelope.ts:11 定义）

**评价**：agent 透明（ADR-004）真生效 — 全部由 envelope-builder 推导，agent 一字未填。

---

## 6. M5 失真截断修复（return-path-payload.ts）✅

实读 packages/api/src/orchestrator/return-path-payload.ts:18-32：

**修复前**：500 字硬截断（小孙 R-201 抱怨 4195 字 review 被截）

**修复后**：
- 默认 16k token cap（`getA2APayloadMaxTokens()` 可配）
- 截断方式：head 60% + tail 30%，中间显式 `(省略 N 字)`
- 截断时附 `[msg_id=<dbMsgId>]` 引用 → 下游可调 MCP get_room_context 查原文

**评价**：✅ 真修了。M5 R-034 回归测试覆盖。

---

## 7. 11 不变量证据验证

实读 `docs/features/F026-a2a-reliability-layer.md` 80-145：

| 不变量 | 测试证据 | 验证状态 |
|---|---|---|
| **I1'** Mention 三层 fail-closed | mention-router.layer1/2/3 + call-tag/rate-limit/on-behalf 6 文件 + gray-zone-event 测试 | ✅ Red-case fixture 覆盖 LL-028 code block 级联事故 |
| **I2-a** 同 turn 单行 message | `__tests__/a2a-replay/R-184-same-turn-single-row.test.ts` | ✅ R-184 lock |
| **I2-b** Worklist 续推降级 | ADR-002 设计决策 | ✅ |
| **I3** Broadcaster 后端强隔离 | `routes/ws-routing.test.ts:86` fuzz 10000 条 0 泄漏 | ✅ |
| **I4** Registry 持久化 + CAS | `call-registry.test.ts` (CAS:206 / settle:154 / timeoutScan:213) + `p4-restart-recovery.test.ts` (kill -9 全恢复) | ✅ |
| **I5** Observable State + 前端栏 | `debug-a2a.test.ts` + 前端 6 commit (溯源胶囊 / Pulse / 墓碑 / Visual Silo / debug 视图) | ✅ |
| **I6** 身份贯穿 | a2a-gateway callId + timeoutScan + callback token TTL 3h | ✅ |
| **I7** Call Tree 贯穿 | call-registry.getTree + a2a_calls 9 字段 | ✅ |
| **I8** Envelope 双层 + 版本化 | envelope-builder.test.ts + a2a-envelope.test.ts | ✅ |
| **I9** Branch Isolation | call-registry.test.ts:108 pendingOf only siblings + sibling-guard.test.ts | ✅ |
| **I9'** Continuation Guard | worklist-executor.test.ts R-095/R-096 重放 lock | ✅ |
| **I10** Convener Explicit | a2a-calls.test.ts convener_id + envelope-builder convener | ✅ |
| **I11** A2A 对 agent 透明 | B022 砍三家 .md + ADR-004 guard scripts | ✅ |

**总评**：11 不变量全部有 line-level 测试引用，**不是空头承诺**。

---

## 8. 真瑕疵清单（小孙知情用）

### 真瑕疵 1：ADR-002 / ADR-003 缺 CI guard ⚠️ 中风险

**事实**：
- ✅ ADR-004：`scripts/ci/check-adr-004-content.ts` + `check-adr-004-diff.sh`（配套 4 case 测试）
- ❌ ADR-002：仅"字段保护降级单测覆盖"（commit a76cde1）— 不是文件级 diff guard
- ❌ ADR-003：50 动词白名单已被方案 X 取代失去对象，status: Amended，**无 guard**

**风险**：未来有人改 a2a_calls schema 删 convener_id（ADR-002 核心字段）或者改回 50 动词白名单 prompt 教育（违 ADR-003），**无 CI 阻断**。靠测试覆盖 = 弱保护。

**F026 closing log 2026-04-30 已经标注**：「ADR-002/003 真欠账，等小孙拍 [A] 立刻补 / [B] Step 5 后另立 cleanup 子任务做」—— **小孙到合 dev 时仍未拍**，欠账带进 dev。

**建议**：V16.5 第一批立项后单独立 cleanup 子任务补 ADR-002/003 guard。

---

### ~~真瑕疵 2：场景 2 多人讨论无真机验收~~ — 撤回

**v1 判断**：F026 spec 体感场景只列场景 1 + 场景 3，场景 2 多人讨论收敛权未单独验收。

**v2 撤回理由**（小孙 2026-05-08 指证）：小孙在 **R-211「D-多agent评价」** 真机手验过场景 2，对话实证：
- 小孙发起："@黄仁勋 帮我叫一下桂芬和德彪..."
- 黄仁勋同消息 `[Call: @桂芬 ...]` `[Call: @范德彪 ...]` **并发派发**
- 桂芬 + 范德彪 **并发交活**
- 黄仁勋 **合并收敛**（"村长，桂芬和德彪都交活了...我合一下"）— 收敛权在发起 agent

**完全符合 R-201 第 5 条愿景**「如果是 agent 发起，那么应该由发起的 agent 收敛」。F026 实际真机验范围**比 spec 文字范围大**，只是 spec 体感场景文字模板只列了 2 个名字，**不是真欠账**。

**结论**：场景 2 已验，无 V16.5 立项前阻断。

---

### 真瑕疵 3：API 测试 8 skipped + 1 timing flake ⚠️ 低风险

**事实**：
- pnpm test:api：1432/1440（不是 1432/1432）
- 8 skipped — 包括 P5 fake-runtime e2e（小孙 [Q1=B] 处置：CAS 单元 + 重启恢复双层兜底足够）
- 1 timing flake — base-runtime.test.ts 25ms heartbeat 紧时序（隔离重跑 13/13 全绿）

**风险**：低。8 skipped 大部分是有意跳过（双层兜底 / 不是回归 case）。timing flake 隔离重跑通过。

**建议**：知情即可，无需阻断。

---

## 9. 需关注点（不是缺陷，但要知道）

| # | 点 | 影响 V16.5 |
|---|---|---|
| **N1** | a2a_calls 无 result/error 字段，failed/timeout 原因散到 messages.retry_reasons / agent_events | M3 章节 11 viewfinder reference a2a_calls.callId 时只能拿 status，要 reason 得 LEFT JOIN messages.a2a_call_id |
| **N2** | a2a_calls / a2a_worklists 无 FK to session_groups | 命名空间正交不冲突，但 V16.5 章节 9 / 11 不能 cascade delete 跨表 |
| **N3** | a2a_worklists.items JSON 无 schema 约束 | 不直接影响 V16.5（worklist 是 F026 内部 state）|
| **N4** | MCP 程序化派发 P15 待 acceptance-guardian 穷举 | F026 后续 cleanup，V16.5 不涉及 |
| **N5**（范 review 补）| Worklist cascade 中间崩溃缺 recovery job 扫描重跑 | 不影响 V16.5；F026 cleanup follow-up：加独立 job 扫"items 全 done + children 全 settled 但自身 active"的 worklist 重跑 cascade，避免依赖 onChildFinished 后续触发 |

---

## 10. 对 audit-v4 V16.5 修订建议的重新判断

audit-v4 提了 6 处 V16.5 修订（M1-M6）+ 决策 9。**深审后判断**：

| 修订点 | F026 深审后判断 | 调整 |
|---|---|---|
| **M1** 章节 4 a2a_handoff handoffContext 来源 envelope | ✅ envelope 设计干净 + 双层结构清晰 + agent 透明 | **不变** |
| **M2** 章节 9 open_threads ref a2a_calls.callId | ✅ a2a_calls 表字段完整 + CAS 干净 | **不变** |
| **M3** 章节 11 viewfinder ref a2a_calls.callId/status | ✅ callRegistry.findByStatus / getSessionTrees 设计干净 | **加注解 — reason 不在 a2a_calls 表，要 LEFT JOIN messages（N1）** |
| **M4** 章节 18 RuntimeLog 复用 F026 前端 + /debug/a2a | ✅ /debug/a2a 4 种查询 + 前端 6 commit 落地 | **不变** |
| **M5** 删 "F026 接口未拍" 风险行 | ✅ 接口已落地 | **不变** |
| **M6** Changelog | ✅ | **不变** |

**新增（深审发现）**：
- ~~**M7** — V16.5 第一批立项前手验场景 2 多人讨论~~ **撤回**（小孙 R-211 已验，见瑕疵 2 修订）
- **M8（建议）** — V16.5 第一批立项后单独 cleanup 子任务补 **ADR-002/003 CI guard**（F026 真欠账）

---

## 11. 总评

✅ **F026 整体高质量** — 设计严谨（ADR-002/003/004 三方独立收敛）+ 算法精良（CAS / tryCascadeSettle / 三层 fail-closed）+ 测试覆盖到位（11 不变量全有 line-level 引用 + 14 症状回归 14/14）+ 历史教训正反馈（P1 Wiring Debt 发现后补完 + DoD-1 加孤岛审视）。

⚠️ **2 处真瑕疵 + 1 处撤回** —
1. ADR-002/003 缺 CI guard（**真欠账**，cleanup 子任务）
2. ~~场景 2 多人讨论体感漏验~~ **撤回** — 小孙 R-211 已真机验（spec 文字模板未列，但实际验过）
3. 8 skipped + 1 timing flake（低风险，知情即可）

🟢 **F026 不阻断 V16.5 立项**。audit-v4 的 V16.5 修订建议（M1-M6）深审后**全部成立**，新增 M7/M8 两个 follow-up。

---

**生成于**：2026-05-08，黄仁勋  
**深审耗时**：~1 小时  
**深审依据**：944b7b1 commit + ADR-002/003/004（611 行）+ schema.ts (a2a_calls 字段) + sqlite.ts (a2a_worklists DDL) + call-registry.ts (398 行)实读关键路径 + worklist-registry.ts (241 行)实读 tryCascadeSettle + mention-router.ts (688 行)实读三层 + envelope-builder.ts (116 行) + a2a-lifecycle.ts (126 行) + return-path-payload.ts (M5 修复) + F026-a2a-reliability-layer.md 11 不变量证据 evidence + F026 closing log
