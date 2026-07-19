# F037 2026-07-18 日报修复实施计划

**Feature:** F037 — `docs/features/F037-daily-news-digest.md`
**目标:** 修复当日 smol/Digg 双信源失败和 Classic Outlook 社区卡大留白，经隔离全链验证与独立验收后，只向 `sundengjun1@huawei.com` 重发一次修正版。
**架构:** Preserve 模式。源修复只扩 smol 的源级预算并兼容 Digg 新旧 schema；renderer 只拆分标题内嵌超长 URL 的风险配对；重发消费已验收的 shadow 产物，不调用生产 `send-now`。

## Task 1：锁定双信源失败合同

- 在 Digg 测试中加入 `top.posts` RED，并保留旧 `top.items` fixture。
- 用 HTTP mock 断言 smol 显式传递 3 MiB，SafeHttp 全局默认仍精确为 2 MiB。
- 定向测试先 RED 后 GREEN。

## Task 2：最小修复双信源

- 只在 `storiesByFilter.top` 内读取 `posts ?? items`。
- 给 RSS 定义和 fetch 链透传可选 `maxBytes`；仅 `smol-ai` 设置 `3 * 1024 * 1024`。
- 不修改全局网络安全默认值。

## Task 3：锁定 Outlook 结构性留白

- 保留 B035：普通 13+ ASCII token 仍在双栏并带 `break-all`。
- 新增 B037：标题内嵌超长 URL 的配对不得生成 272px 双栏 cell，两张卡按原顺序变成独立整宽 row，标题和 href 原样保留。
- 现有普通双栏 gutter 测试继续防止全量退化。

## Task 4：最小 renderer 修复

- 新增窄触发器 `needsOutlookWideRow`，只识别 `https?://` 后足够长的连续 URL。
- 配对进入 `twoColRow` 前检查两侧标题；命中时复用现有 `wideRow` 和 `renderCardInner`。
- 不改变 Markdown、条目顺序、密度策略或 98 KiB 终态预算。

## Task 5：回归与同源证据

- 运行定向测试、全 packages 测试、components、typecheck、lint、build。
- 用正式 2026-07-18 archive 做只读 renderer 重放，断言文本、链接、Markdown、条目 ID 与顺序保持一致，且生产树哈希不变。
- 生成 HTML/EML 证据。因内置浏览器拒绝 `file://` 且本机无 Outlook，明确记录 Classic Outlook 截图不可得，不把它伪报为通过。

## Task 6：隔离全链重建

- 复制生产日报状态到唯一 shadow root；移除子进程 HTTP 代理、本地 RSSHub 和 SMTP 凭证，使用 mock sender。
- 非故障源复用正式快照；smol 直接 SafeHttp 复验；Digg 直连网络不可用时，只允许使用同日官方 Digg 原始 RSC，并必须经过产品 `parseDiggStories → makeDiggAiSource`。canonical fetch 成功但解析为 0 时立即 fail-closed，后续网络错误不得覆盖。
- 断言两源均有证据、无失败源、无异常 banner、目标唯一、HTML 低于预算、生产树零变化。

## Task 7：一次性定向重发与闭环

- quality-gate PASS 后，由零上下文独立 agent 执行 acceptance-guardian；未获 PASS 不发送。
- 发送脚本默认只预检；`--send` 才创建 `wx` marker，并以 exact allowlist 调用现有 SMTP sender 一次。
- 发送前锁定目标、主题、HTML/Markdown 哈希、信源健康、Outlook 结构和生产树哈希。
- 成功后只允许追加 outbound ledger 与更新 marker；archive、shown、rank、sent 等其余文件必须保持不变。
- SMTP 失败或结果未知时记录 `do_not_retry`，禁止自动重试。
