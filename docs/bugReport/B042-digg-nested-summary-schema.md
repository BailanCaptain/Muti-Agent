# B042 — Digg RSC 嵌套摘要字段漂移

Related: F037
Status: verification

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | 2026-07-23 正式日报将 `digg-ai` 标为 `failed / 0 条`，错误为 `no stories parsed from https://digg.com/tech/`。 |
| 2 | **证据** | 正式归档 43 个源中仅 Digg 非 `ok`；生产同姿势实时抓取返回完整 Tech News 页面，RSC `top.posts` 有 25 条，但产品 parser 返回 0。 |
| 3 | **假设** | Digg 将根级 `title/tldr` 迁到 `summary.title/summary.description`，现有 parser 因根级标题为空而丢弃全部条目。 |
| 4 | **诊断策略** | 用当前 schema 的最小 RSC payload 写回归测试；确认旧实现以预期原因失败，再加根级优先、嵌套字段回退。 |
| 5 | **超时策略** | 15 分钟内若红测原因不符，重新抓取成功样本并只输出结构键，检查是否存在第三种容器或字段形态。 |
| 6 | **预警策略** | 若修复必须放宽 `clusterUrlId`、JSON 边界或空源门禁，停止并升级，因为会扩大不可信页面误解析面。 |
| 7 | **用户可见修正** | 不改 Cookie、代理或配置；修复后后续日报不再因该 schema 漂移显示 Digg 异常卡。 |
| 8 | **复现验收** | 新 nested-summary 用例 RED→GREEN；旧 `items`、根级 `posts`、parser-zero fail-closed 用例保持通过；生产同姿势只读实时抓取返回至少 1 条规范化 Digg item。 |

## 原始需求

> “为什么信源又失效了”
>
> “那你修  修完合入”

## Bug Report 六件套

1. **报告人**：小孙在 2026-07-23 正式日报的 SOURCE ALERT 中发现。
2. **Bug 现象**：见诊断胶囊；日报整体成功，但 Digg 板块缺失。
3. **复现步骤**：
   1. 读取 2026-07-23 正式 `summary.json`，`digg-ai` 为 `failed / 0`，其余 42 源为 `ok`。
   2. 用生产同姿势 SafeHTTP 读取 `https://digg.com/tech/`：页面与 RSC 完整，`storiesByFilter.top.posts` 有 25 条。
   3. 将当前结构交给旧 `parseDiggStories()`：条目只有 `summary.title/description`，旧实现读取根级 `title/tldr`，实际返回 `[]`；期望返回可规范化 story。
4. **根因分析**：Digg 没有稳定公开 RSS/JSON，本源解析其 Next.js 私有 RSC。B037 只兼容了集合键 `top.items → top.posts/items`，但人工 `posts` 回归 fixture 仍沿用根级 `title/tldr`，没有覆盖 2026-07-23 出现的 `summary.title/summary.description`。网络成功、容器与 ID 均正常，25 条记录在根级标题空值门被全部丢弃。
5. **修复方案**：保持 `top.posts/items`、JSON 边界、`clusterUrlId` 白名单和 parser-zero fail-closed 全部不变；标题与摘要继续优先读取根级字段，仅在缺失时分别回退 `summary.title` 与 `summary.description`。
6. **验证方式**：
   - RED：新增 nested-summary 回归后，目标测试 `9 pass / 1 fail`，实际 `[]`、期望 1 条，失败原因与正式症状一致。
   - GREEN：首版目标测试 `10/10 pass`；旧 `items`、根级 `posts`、parser-zero fail-closed 全部保持通过。
   - 实时复现：生产同姿势只读抓取规范化 `15` 条，全部为 `community` 且 URL 均匹配 `https://digg.com/tech/{id}`；榜首标题、链接与摘要来自当前 RSC。
   - Peer review r1：发现 nested object/array/boolean 会被 `String()` 强转、F037 唯一真相源仍写旧 `/ai` schema、tracked 测试未锁根级优先/逐字段回退/空串合同，共 `3 P2`。错型用例稳定 RED 为 `11 pass / 2 fail`；实现只收紧 nested 字符串边界，保持根级旧合同，更新主表 v2.3（`40 → 40`）并补持久化矩阵后 GREEN 为 `13/13`。
   - Review 修补后 Quality Gate：`git diff --check`、typecheck、lint（0 error）、check（0 error）、build、API 全量测试（exit 0）与组件 `903/903` 均通过；Windows 下显式让进程使用 Git Bash，未改配置。Feature Gate 再次经生产同姿势 SafeHTTP 规范化 `15` 条。
   - Review 修补后独立 Guardian 再次 PASS；同一 reviewer 最终复审 `Approved / LGTM`，`P0=P1=P2=P3=0`。次日正式日报的 Digg 实收健康仍由既有 F037 监控确认。
