# F037 B045 Weekend Roundup Sections Implementation Plan

**Feature:** F037 — `docs/features/F037-daily-news-digest.md`
**Goal:** 周一正文仍严格只取上海时区周六/周日，但恢复正常五栏结构，并用稳定公开 AI 社区 RSS 替换持续 429 的 Digg。
**Acceptance Criteria:** 周一运行 GitHub 四榜并显示开源榜单；正文/播客日期门不放宽；无周末播客时显示诚实空态；Digg 不再进入运行清单，替代源可经生产 SafeHTTP 解析；GitHub/空态不能兜底空壳；非周一行为不变。
**Architecture:** 将“新闻日期窗”和“状态快照栏”拆开：AI/community/hot/podcast 继续经过周末日期门，GitHub 四榜照常采集并附在 publication。Renderer 在周一保留固定五栏骨架，对空播客渲染无链接空态。社区源在 registry 单一入口以公开 RSS 等量替换 Digg，避免继续解析私有 RSC 或绕过 429。
**Tech Stack:** TypeScript、Node test runner、SafeHttpClient、RSS/Atom parser、HTML/Markdown renderer。

---

## Finish line

修正版周一邮件必须同时满足：五栏可见、正文日期零越界、43 路运行清单无失败、GitHub-only 仍不发送。不会放宽周末正文到周五/周一，也不会修改凭证、代理或运行时配置。

### Task 1: 锁定 Monday GitHub 与空壳门合同

**Files:**
- Modify: `packages/api/src/services/daily-digest/daily-digest-job.test.ts`
- Modify: `packages/api/src/services/daily-digest/daily-digest-job.ts`

1. 把旧“周一不调用 GitHub”用例改成 RED：周一混合周五/周六/周日/周一正文和四榜输入，期望正文只保留周六/周日、GitHub 四源全部调用并进入 publication。
2. 跑定向测试，确认因 `weekendRange ? [] : [...]` 而失败。
3. 最小实现为 GitHub sources 不再受 `weekendRange` 禁用：

   ```ts
   const githubSources = [
     ...(run.githubDailySources ?? []),
     ...(run.githubSources ?? []),
     ...(run.githubMonthlySources ?? []),
   ]
   ```

4. 复跑并保留“全正文未决 + GitHub 非空”零 archive/attempt/shown/outbound 用例。

### Task 2: 锁定周一五栏展示

**Files:**
- Modify: `packages/api/src/services/daily-digest/renderer.test.ts`
- Modify: `packages/api/src/services/daily-digest/renderer.ts`

1. 写 RED：周一有 AI/hot/GitHub、无 community/podcast 时，HTML 与 Markdown 仍按 `AI → 社区动态 → 周末热点 → 播客速递 → 开源榜单` 输出，空社区与播客显示诚实空态，刊头包含开源榜单。
2. 跑定向测试，确认当前 renderer 只输出四栏或三栏。
3. 让周一固定保留全部五个 section meta；仅当精选与速览候选都为空时输出无链接空态卡，不伪造 publication item，也不吞掉 rest-only section。
4. 周二至周五继续沿用“无新集则播客整节不出现”的既有行为。

### Task 3: 用公开 RSS 等量替换 Digg

**Files:**
- Modify: `packages/api/src/services/daily-digest/sources/registry.test.ts`
- Modify: `packages/api/src/services/daily-digest/sources/registry.ts`
- Modify: `packages/api/src/services/daily-digest/boot.ts`
- Modify: `packages/api/src/services/daily-digest/source-labels.ts`
- Modify: `packages/api/src/services/daily-digest/source-labels.test.ts`
- Modify: `packages/shared/src/digest-tags.ts`
- Modify: related renderer/summarizer fixtures that enumerate `digg-ai`

1. 写 RED：完整源清单包含替代源、不含 `digg-ai`，数量守恒；公开 RSS fixture 能解析为 `community` items；社区子栏显示替代源名。
2. 跑测试确认旧清单失败。
3. 在 `RSS_SOURCES` 加入经活体验证的公开 AI 社区 RSS，移除 boot 的 `makeDiggAiSource()` 与设置页元数据中的 Digg；保留旧 parser 文件仅作历史兼容，不再进入运行路径。
4. 用同一 SafeHTTP/代理姿势做只读 live probe，要求 HTTP 200、解析非空且 source health 为 ok。

### Task 4: 同步真相源与完成验证

**Files:**
- Modify: `docs/features/F037-daily-news-digest.md`
- Modify: `docs/discussions/F037-sources-v2-expansion.md`
- Complete: `docs/bugReport/B045-weekend-roundup-section-regression.md`

1. 修正 AC26/D21：周末日期门只约束新闻流；GitHub 是周一时点快照且仍不能兜底空壳。
2. 更新源主表为等量替换，记录 Digg 持续 429 与替代源选择理由。
3. 运行 B045 定向测试、F037 全量、typecheck、build、lint、check-docs、全量 `pnpm test`。
4. 经 quality-gate、零上下文 acceptance guardian 与 peer review 放行后提交；合入本地 dev。
5. 用新代码单次生成修正版，发送前确认当天账本允许显式补发；发送后核对五栏、日期、sourceHealth 与唯一新增 outbound 记录。

## 收敛检查

1. 否决理由 → ADR？没有；这是现有 F037 合同纠偏，不新增架构方案。
2. 踩坑教训 → lessons-learned？有：把时间范围约束扩大成栏目删除，且测试锁死错误需求；完成时追加。
3. 操作规则 → 指引文件？没有；现有“原话愿景对照”流程已覆盖，问题是执行失误。

## 完成记录（2026-07-27）

- 定向验证：API `144/144`、Digest 组件 `30/30`；typecheck、lint、check、build 与全量 `pnpm test` 均为 0 失败。
- 独立门禁：Acceptance Guardian r3 PASS；peer review APPROVE。
- 实发结果：`status=ok / degraded=false`，外发账本 `46→47`；五栏顺序固定，正文日期越界 0。
- 信源结果：`43/43 ok`；`lobsters-ai` 返回 25 条，运行清单不含 `digg-ai`；GitHub 四榜共发布 16 条。
