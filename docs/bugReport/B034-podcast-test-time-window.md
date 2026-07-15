---
id: B034
title: 播客测试固定日期越过七天窗口后失效
status: fixed
reported_by: 范德彪
reported_at: 2026-07-16
related: F037 后续邮件视觉补丁（合入门禁中发现）
---

# B034 — 播客测试固定日期越过七天窗口后失效

## 诊断胶囊

| # | 栏位 | 内容 |
|---|---|---|
| 1 | **Bug 现象** | `pnpm test` 在 2026-07-15 晚间开始稳定出现 5 个播客测试失败：窗内新集数量从期望值降为 0，两个“转写失败应抛错”用例也因没有候选集而未进入转写。 |
| 2 | **证据** | 失败均位于 `packages/api/src/services/daily-digest/sources/podcast.test.ts`；测试把 `FRESH_PUB` 固定为 `2026-07-08T13:30:00Z`，生产筛选 `withinRecentWindow` 使用真实 `Date.now()`。相关播客文件与 `origin/dev` 零差异。 |
| 3 | **假设** | 根因是测试同时使用“固定历史日期”和“生产真实时钟”；当真实时间超过固定时间 7 天后，原本的“新集”夹具自动变成窗外数据。 |
| 4 | **诊断策略** | 在干净 `origin/dev` 同源 worktree 复跑 `podcast.test.ts`，确认 5 个同样失败；对照 `registry.ts` 的时效窗合同，验证生产代码有意使用真实时钟，修复应只调整测试夹具。 |
| 5 | **超时策略** | 10 分钟内若失败数或堆栈不一致，则停止修改并检查缓存目录、时区和并发测试污染；不修改生产筛选逻辑。 |
| 6 | **预警策略** | 若修复需要改变播客生产代码、7 天业务定义或运行时配置，立即升级给小孙；当前授权仅覆盖测试日期修复。 |
| 7 | **用户可见修正** | 无产品行为变化；只恢复全量门禁的时间稳定性，以便邮件视觉 feature 按流程合入。 |
| 8 | **复现验收** | RED：`pnpm exec tsx --test packages/api/src/services/daily-digest/sources/podcast.test.ts` 出现 5 failures；GREEN：同命令全部通过，随后 `pnpm test` 全绿。 |

## Bug Report 六件套

1. **报告人**：范德彪；在已合入 F037 的后续邮件视觉补丁执行全仓门禁时发现。
2. **Bug 现象**：`podcast.test.ts` 中 5 个用例随日历时间推进自动失效；“7 天内”的固定 2026-07-08 夹具在 2026-07-15 晚间越过生产时效窗后，候选数量变为 0。
3. **复现步骤**：在 2026-07-15 晚间或更晚运行 `pnpm exec tsx --test packages/api/src/services/daily-digest/sources/podcast.test.ts`；修复前得到 13 tests、8 pass、5 fail，其中窗内收录和两个转写异常路径均未进入预期分支。
4. **根因分析**：测试把 `NOW`、`FRESH_PUB` 与缓存 `publishedAt` 写死在 2026-07-08/10，生产 `withinRecentWindow` 则有意使用真实 `Date.now()`。固定夹具和真实时钟混用，使测试只有约 7 天有效期；生产代码与 `origin/dev` 一致且业务语义正确。
5. **修复方案**：仅调整测试夹具：以测试进程启动时的真实时间为基准生成 `NOW-2 天` 的新集和 `NOW-13 天` 的旧集，并让解析断言、缓存记录共用同一 `FRESH_ISO`。不改生产代码、7 天业务定义、运行时配置或日报行为。
6. **验证方式**：
   - RED：定向测试 13 项中 5 项失败，错误与全仓门禁一致。
   - GREEN：同一定向命令 13/13 通过。
   - 全仓：先构建 API 所需 `dist/mcp/server.js`，随后 `pnpm test` 为 API 4669 pass / 0 fail / 1 skipped / 1 todo，组件 903/903 pass。
   - 静态与构建：`pnpm typecheck`、`pnpm check:docs`、`pnpm lint`、`git diff --check`、shared build、API build 均 exit 0；全仓 lint 仅报告既有 warnings，未产生 error。

## Quality Gate

- **愿景对照**：只恢复测试的时间稳定性，不改变已合入 F037 或其邮件视觉补丁的任何产品行为。
- **交付完整性**：测试夹具与 bug report 构成完整的独立 bugfix；生产文件零改动。
- **原症状复验**：原 5 个失败已在同一路径下转为 13/13 通过。
- **广域回归**：API 与组件共 5572 项通过、0 失败。
- **结论**：PASS，可进入零上下文独立验收。
