# F027 v3 PATCH · 12 gap 闭环（2026-05-28）

> **v3 patch 形式**（非 Round 2 重拍）— 沿用 V16.5-final.md spec + F027 feature.md AC，
> 只在原 Phase 1-4 之上叠 G1-G12 12 gap 修复，每个 gap 对应独立 commit + V16.5 章节追溯。
>
> **触发**: 小孙 5-28 audit 实测发现 "F027 Phase 1-4 + final-vision r1-r5 已声称做完，
> 但 walkthrough 时多处 placeholder / cap=0 硬编码 / cron noop / 哲学 UI 没翻译"。
> 派 4 个并行 Explore agent 全量 spec-vs-impl audit，verify 后 12 真 gap (G1-G12)。

---

## 1. 修前状态 (audit 真实证据)

来源: `.runtime/reviews/F027-fullscan-audit-summary.md` (2026-05-28 audit verdict)

### 12 真 gap 概览

| Gap | 严重度 | 真相源 | 修前状态 |
|-----|--------|--------|----------|
| **G1** Token 预算 cap + drop reducer | P0 ★★★ | V16.5 chap 20 line 2273-2275 | `message-service.ts:650 cap:0` + `:652 notInjectedJson:null` 硬编码；`context-assembler.ts` 全文无 cap; 前端 `prompt-inspector-tab.tsx:126 cap=5500` 占位 |
| **G2** 5 cron jobs scan callback | P0 ★★ | V16.5 chap 17 line 1800-1854 | `scheduler-bootstrap.ts:183-205` 5 个 `async () => []` noop fallback |
| **G3** viewfinder generated_by 字段 | P1 ★ | V16.5 chap 11 line 1255 | `viewfinder-renderer.ts:39` 硬编码 "RoomCompiler (rule-based template)" → 字段名暗示多 generator 备选 |
| **G4** Prompt Inspector alias filter | P0 ★ | V16.5 chap 13+18 | `prompt-inspector.ts:108` WHERE 只 room_id → 多 agent room 只显最后一个 |
| **G5** NotInjectedSection 真渲染 | P0 (链 G1) | V16.5 chap 18 line 2050-2053 | `prompt-inspector-tab.tsx:390-404` "⏳ Week 5 接" 占位 |
| **G6** llm-wiki 哲学 UI | P0 ★★ 愿景层 | V16.5 chap 1-3 + 11-14 | UI 5 tab 只露后端 CRUD; 无哲学叙事 / 6 桶分类 / canonical_owner 链 / 增长曲线 |
| **G7** max_staleness 3 策略分支 | P1 | V16.5 line 939-943 | 实际**已实施** (audit 漏看 staleness.ts:53-78 switch) |
| **G8** Adaptive Recall 5 字段人话 | P1 | V16.5 chap 12 | `prompt-inspector-tab.tsx:458-491` 直接展示原始字段名无说明 |
| **G9** viewfinder frontmatter 字段说明 | P1 | V16.5 chap 11 line 1255 | yaml 渲染直接显示无说明 panel |
| **G10** open_threads JSON union validator | P2 | V16.5 chap 9 line 1069 | schema 是 TEXT 列存 JSON, repo hydrate 不检每项 shape |
| **G11** LLM compile pipeline 端到端 | P2 (架构) | V16.5 chap 26 | 修前: `runCompilePipeline` 实际**未** wire 到 production ingest-commit/preview。**2026-05-30 已接通**（Opus 4.7，commit f550946→29ecd9b→c7fb809，德彪两轮 review PASS）→ 详见 §4 |
| **G12** a2a_calls perf ≤50ms test | P2 | V16.5 chap 11 a2a_calls index perf AC | 6 个 index 全有但无专门 perf 断言 test |

### 痛点 6 类 + 北极星 5 条 修前状态

| 痛点 | 修前 audit verify |
|------|---|
| 1. Agent 知识黑盒 | ✅ PASS (Phase 4 P4-8 真实施) |
| 2. 反复教 agent | ◐ 后端 OK / G4 多 agent 看不全 |
| 3. 决策漂移 | ◐ 后端 OK / G3 generated_by 硬编码 + G2 DriftDetector noop |
| 4. **Prompt 注入冗余** | ❌ **G1 整章节没接** (cap=0/drop order 缺) — 整体未闭环 |
| 5. docs/ 召回 | ✅ PASS (P1-2 真接) |
| 6. 拍板理由不追溯 | ◐ wiki_events PASS / G2 DriftDetector noop → 主动告警没做 |

| 北极星 | 修前 audit |
|------|---|
| 新 agent 不白板 | ✅ |
| 不反复教 | ◐ 链 G4 |
| 决策不漂移 | ◐ 链 G2+G3 |
| **错误模式不重复** | ❌ **G2 DriftDetector noop → 未兑现** |
| 每条对应 phase AC | ✅ |

---

## 2. v3 patch 11 commit 闭环

| # | Commit | Gap | 真相源 V16.5 章节 | Codex verdict |
|---|--------|-----|------------------|---------------|
| 1 | `febaff5` | G1 | chap 20 line 2273-2275 | PASS (r1) |
| 2 | `806f5fb` | G2 | chap 17 line 1800-1854 | FAIL r1 → 修 |
| 3 | `a3b1c6a` | G2 r2 | (wikiRoot 路径) | PASS r2 (CONDITIONAL → 修) |
| 4 | `b42c9b9` | G2 r3 | (server wiring lock) | PASS r3 |
| 5 | `d149f13` | G3 + G4 + G5 | chap 11/13/18 | CONDITIONAL_PASS → 修 |
| 6 | `6af2efc` | G4 r2 | (stale state 修) | PASS |
| 7 | `87f384a` | G6 | chap 1-3 + 11-14 | CONDITIONAL_PASS → 修 |
| 8 | `3896875` | G6 r2 | (fail-soft 修) | PASS |
| 9 | `4a91709` | G7 (verify) + G8 + G9 + G10 + G12 + G11 (推 F-id) | chap 9/10/11/12 + a2a perf AC | CONDITIONAL_PASS → 修 |
| 10 | `241631b` | G9 r2 | (nested skip 修) | PASS |

11 commit 全部 codex review 闭环 PASS (r1 CONDITIONAL_PASS → r2/r3 PASS)。

---

## 3. 修后状态 (痛点 6 类 + 北极星)

| 痛点 | 修前 | 修后 |
|------|------|------|
| 1. Agent 知识黑盒 | ✅ | ✅ |
| 2. 反复教 agent | ◐ | ✅ (G4 alias filter 真接) |
| 3. 决策漂移 | ◐ | ✅ (G3 字段说明 + G2 DriftDetector 接 wiki_events) |
| 4. Prompt 注入冗余 | ❌ | ✅ (G1 cap + drop reducer + G5 NotInjectedSection 真渲染) |
| 5. docs/ 召回 | ✅ | ✅ |
| 6. 拍板理由不追溯 | ◐ | ✅ (G2 DriftDetector scanTriggers 接 wiki_events lessons + handoff_failure) |

| 北极星 | 修前 | 修后 |
|------|------|------|
| 新 agent 不白板 | ✅ | ✅ |
| 不反复教 | ◐ | ✅ |
| 决策不漂移 | ◐ | ✅ |
| 错误模式不重复 | ❌ | ✅ (G2 DriftDetector 真接 + 7d 内 lessons 写入 + a2a_calls failed → trigger update draft) |
| 每条对应 phase AC | ✅ | ✅ |

---

## 4. residual / follow-up

### G11 已接通 (2026-05-30 完成，原"推独立 F-id"已落地，不再推 F029)

小孙拍板"不接不是 feature 没完成"→ G11 进 v3（编译模型 **Opus 4.7** = types.ts:6 立项原值）。
`runCompilePipeline` 已 wire 到 production ingest preview/commit 全链路，替换原 stub。

**实现（commit f550946 → 29ecd9b → c7fb809）**:
- 4 适配器: production-compile-llm-client（Opus+Haiku fallback）/ index-lite-loader / entity-existence-checker（防穿越）/ preview-wiki-events-writer（preview no-op）
- ingest-preview.ts: preview() 改 async + 真编译产 compiledMarkdown + 失败 fail-soft 退 stub + compile_failed warning + provenance（user-drop/docs-watcher）
- ingest-commit.ts: 优先落盘 compiledMarkdown；preview-store: +compiledMarkdown 字段；server.ts: 注入真 deps
- 前端 ingest-modal: preview loading 文案反映真编译延迟

**德彪 codex review**: 第一轮 CONDITIONAL_PASS（P1 fallback stderr / P2 路径穿越 / P3 logger）→ receive 全修 + 回归测试 → **第二轮 PASS**。验证: api typecheck 0 + lint 0 + 65 单测全绿。

**follow-up backlog（小孙拍不阻塞）**: index-lite totalContextTokens cap / commit sourceMessageIds 结构化 provenance / Opus rate-limit / WIKI_ROOT 真 entity 目录（concepts/rules 未建，cross_refs 当前降级运行，backfill 跑后恢复）。

### G6 follow-up (推后做)

G6 MVP 限定 4 块 (banner / 6 桶 / supersede 链 / 7d 增长); 推后续:
- **LLM compile pipeline 状态可视化** (chap 26 pre/compile/post 历史) — 需 `wiki_compile_runs` 表 → 独立 F-id
- **drift history timeline** (room_decisions tombstone + supersede 时序可视化) — 需专门 endpoint

### v3 patch 不动 feature.md

按小孙 5-28 拍 "v3 patch 形式 (非 Round 2 重拍)"，本 patch 不修 `feature.md` AC 列表。
- 12 gap 全部追溯到 V16.5-final.md 原章节 (chap 1-3/11/13/17/18/20/26)
- AC 都在 Phase 1-4 plan 里, gap 是"已声称做完但实际硬编码/noop" — 不是新 AC
- ~~后续 F029 接 G11 LLM compile pipeline 时再独立立项~~ → **G11 已直接进 v3 接通（2026-05-30），不再推 F029**（小孙 5-29 拍"不接不是 feature 没完成"）

---

## 5. 测试覆盖 + 完整验证

### 新增测试 (v3 patch 期间)

| Test file | 新增 case 数 | Cover |
|-----------|--------------|-------|
| `context-assembler.test.ts` | +4 | G1 cap/DROP_ORDER/guardian |
| `wiki-scanners.test.ts` (新) | +11 | G2 5 scanner + wikiRoot 约定 + server wiring source-lock |
| `prompt-inspector.test.ts` | +4 | G4 alias filter + selectedAlias/availableAliases |
| `prompt-inspector-tab.test.tsx` | +4 | G4 AliasFilterRow 三态 |
| `viewfinder-renderer.test.ts` | -1+3 | G3 generated_by 改值断言 |
| `wiki-story.test.ts` (新) | +6 | G6 buckets + growth + schema mismatch fail-loud |
| `agent-sessions.test.ts` | +6 | G10 isOpenThread / sanitize / hydrate |
| `a2a-calls.test.ts` | +1 | G12 perf ≤50ms |

总计 **+38 test cases** 全 PASS。

### 全量验证

- `pnpm typecheck` PASS
- `pnpm test:api` 2855/2855 PASS (含 G2/G6/G10/G12 backend)
- `pnpm test:components` 561/561 PASS (含 G4/G6/G8/G9 frontend)
- 11 commit 全部 codex review PASS

---

## 6. walkthrough 指南 (小孙)

worktree-preview 重启后, 验证清单:

```powershell
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027
pnpm worktree:preview
```

打开 :3100 浏览器后核:

### G1 + G5 Prompt Inspector
- 切到 "system prompt" tab
- 看 HeaderRow 显 `cap 6700` (不再 5500 占位) + `(N%)` 百分比
- 看 NotInjectedSection: 全注入成功显 "✅ 全部注入成功"; 溢出时显具体 part 列表

### G4 Prompt Inspector alias filter
- 多 agent room (黄/范/桂同 room) 切 system prompt tab
- 看新 "🤖 Agent" 行: 0 alias 显 "—"; 1 alias 只读; ≥2 alias dropdown 可选
- 切 alias → 看 Inspector 数据切换

### G3 + G9 viewfinder
- 切到 "取景器" tab
- 看新 "📋 取景器 frontmatter 字段说明" panel (V16.5 chap 11 字段语义)
- hover 字段名看 tooltip; generated_by 字段值显 "rule-based-template # ..."

### G6 Wiki 哲学 UI
- 切到 "知识库" tab
- 看顶部 "🧠 Wiki 是 LLM 第一公民" 紫色 banner
- 6 桶卡片 (room/project/user/feedback/work/conversation) 点开看 top entity + supersede 链
- 7 天增长曲线 (蓝柱=entity / 紫柱=decision)

### G2 cron jobs (后台跑, 看 log)
```powershell
# 等 cron tick 触发 (NightlyHealthCheck 默认 cron `0 4 * * *`, 测试可手动 trigger)
Select-String -Path .runtime\api.log -Pattern "health check done|weekly draft digest done|drift detection done|monthly snapshot done|yearly session archive done" | Select-Object -Last 10
```

### G8 Adaptive Recall tooltip
- system prompt tab Adaptive Recall Policy section
- 每字段后跟 "· 人话说明" 标签
- hover 字段名看 title tooltip (Level 1-5 完整 label)

### G12 perf
- `pnpm exec tsx --test packages/api/src/db/a2a-calls.test.ts 2>&1 | grep G12`
- 期望: a2a_calls 1k row × 3 query 全 ≤ 50ms

---

## 7. 合 dev (Iron Law 边界, 小孙手动)

```powershell
cd C:\Users\-\Desktop\Multi-Agent\.worktrees\F027
git status   # clean
git log --oneline -12
# 切回主仓
cd C:\Users\-\Desktop\Multi-Agent
git checkout dev
git merge --no-ff feat/F027-unified-memory-architecture -m "Merge feat/F027-unified-memory-architecture: v3 patch G1-G12 12 gap 闭环"
git push origin dev
```

---

## 8. 签字

签字 = 小孙浏览器 walkthrough 后 OK + 合 dev 完成。
