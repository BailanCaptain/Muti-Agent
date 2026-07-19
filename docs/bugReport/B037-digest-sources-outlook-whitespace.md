---
title: F037 日报双信源失败与 Outlook 社区卡留白
status: resolved
related: F037
reported: 2026-07-18
---

# B037 — F037 日报双信源失败与 Outlook 社区卡留白

Related: [F037](../features/F037-daily-news-digest.md)

## 诊断胶囊

| # | 栏位 | 内容 |
|---|---|---|
| 1 | Bug 现象 | 2026-07-18 正式日报中 `smol-ai` 与 `digg-ai` 失败；Classic Outlook 把社区区一张含超长 URL 的卡片折成很多行，而它与短卡共享同一 table row，导致短卡下方出现大块空白。 |
| 2 | 证据 | 正式归档 `summary.json` 分别记录 `SafeHttp[too_large] ... > 2097152 bytes` 与 `digg-ai: no stories parsed`。原邮件中相关社区卡位于同一个 560px 双栏 row，Reddit 标题在下一行。 |
| 3 | 根因 | smol 全量 RSS 已增长到约 2.15 MiB，超过共享 2 MiB 上限；Digg 的 RSC 集合键从 `items` 演化为 `posts`；Outlook Word 引擎以同行最高卡片决定整行高度，超长 URL 折行后必然撑高短卡一侧。 |
| 4 | 修复 | 只给 smol 设置 3 MiB 源级预算，保持全局默认 2 MiB；Digg 优先解析 `top.posts` 并兼容 `top.items`，且 canonical fetch 成功但解析为 0 时立即 fail-closed，不能被后续网络错误覆盖；仅当标题内嵌超长 URL 时，把这一对卡按原顺序拆成两个现有 `wideRow`。 |
| 5 | 安全边界 | 不覆盖 2026-07-18 正式 archive、shown/rank/sent ledger；不调用生产 `send-now`；重发仅允许 `sundengjun1@huawei.com`，用原子 marker 防重复。SMTP 失败或结果未知时禁止自动重试。 |
| 6 | 验收 | 96 个定向信源/renderer 测试全绿；API/组件/其余包测试全绿；typecheck、lint、build 全绿。隔离重建无失败信源，smol 678 条、Digg 官方快照 15 条，最终刊发 smol 1 条、Digg 3 条；HTML 83,311 bytes，生产树哈希保持不变。 |

## Bug Report 六件套

### 1. 环境

- 日期：2026-07-18，Windows，Asia/Shanghai。
- 客户端：用户在 Classic Outlook 中观察到排版问题。
- 正式发送 messageId：`<8f6d7455-0917-9cca-a9aa-3f9c1eeac135@qq.com>`。

### 2. 最小复现

1. 读取正式 `.runtime/daily-digest/2026-07-18/summary.json`，可见失败集合恰为 `smol-ai`、`digg-ai`。
2. 用旧解析器读取当前 Digg `storiesByFilter.top.posts` 结构，得到 0 条；读取超过 2 MiB 的 smol RSS，触发 `too_large`。
3. 把一张短标题卡与一张标题含长 URL 的卡放进同一个 272px + 272px table row，在 Outlook Word 引擎中同行按长卡高度展开，短卡侧留下空白。

### 3. 根因

- smol 是单源体积增长，不应通过放宽全局 SafeHttp 上限修复。
- Digg 解析器把旧字段 `items` 当成唯一真相，未兼容新字段 `posts`。
- 旧 renderer 只做文字断词，没有解除两张卡共享行高的结构耦合。

### 4. 修复与取舍

- smol 的 3 MiB 是受限源级预算，当前内容有余量，同时不扩大其他源的攻击面。
- Digg 解析严格限定在 `storiesByFilter.top`，避免误抓页面中无关的 `items`。
- 布局触发器只识别标题中的超长 URL；13 个连续 ASCII 字符仍使用原双栏断词策略，避免普通英文卡片大面积退化为单栏。

### 5. 验证证据

- `pnpm exec tsx --test ...digg-ai.test.ts ...registry.test.ts ...renderer.test.ts`：97/97 PASS。
- `pnpm exec tsx --test "packages/**/*.test.ts"`：4588 PASS，0 FAIL，1 SKIP，1 TODO。
- `pnpm run test:components`：903/903 PASS。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`：PASS。
- 根命令 `pnpm test` 的两个非本改动例外已单独复核：Windows 缺少 `/bin/bash`；`check-adr-004-diff.test.ts` 在未改动的主 worktree 同样失败。排除这两个既有环境/基线项后 scripts 88/88 PASS。
- 只读归档重放保持 Markdown、可见文字、链接及顺序不变；风险配对拆行，安全双栏仍存在；生产日报树哈希前后相同。
- 隔离全链重建使用 mock sender；smol 通过直接 SafeHttp。Digg 直连在本子进程网络不可用后，以同日官方页面逐块封存的 374,170-byte 原始 RSC 经产品 `parseDiggStories → makeDiggAiSource` 实跑：解析 40 条、规范化 15 条；邮件刊发的 3 条标题、URL 与 TLDR 均逐条命中原始 RSC。新增回归证明 canonical parser-zero 只尝试 `/tech/` 一次并保留解析错误。没有信源异常 banner。
- 第二次完整模型重建在 10 分钟工具上限前未写出新工件；未复用其部分状态。发送候选仍是此前已成功、非 degraded 的 shadow 工件，并以当前原始 RSC 对其 3 条 Digg 刊发内容做确定性再验，HTML/Markdown 哈希未变、生产树未变。

### 6. 剩余风险与发送状态

- 本机未安装 Outlook，内置浏览器也不允许打开本地 `file://` 预览，因此没有伪造 Classic Outlook 截图；现有证据是结构合同、归档重放和 EML。最终视觉以目标邮箱中的真实 Outlook 渲染为准。
- 首轮独立验收因“缺同日原始 RSC 产品 parser 证据、parser-zero 可被 network error 覆盖”判 BLOCKED；补齐后第二轮零上下文验收判 PASS。
- 2026-07-18 14:35:21 +08:00 仅向 `sundengjun1@huawei.com` 重发一次；messageId `<ffe5a791-d818-9abb-e90a-70b75ffdce4e@qq.com>`。原子 marker 状态为 `sent`，outbound ledger 精确追加 1 行。
- 发送后剥离该 marker 与 ledger 末行重建发送前生产树，SHA-256 仍为 `1726eeccfe6b2937b66b021f8329e6f453967c700549027c85ee5ee3ae8af9c4`；archive、shown、rank、sent 均未改变。
