# B041 — Outlook 子目录标题与标签间距漂移

**Status:** verification
**Related:** F037

## 诊断胶囊

| # | 栏位 | 内容 |
|---|---|---|
| 1 | **Bug 现象** | 2026-07-22 日报在 Classic Outlook 中，`AI 前沿`、`社区动态`、`今日热点` 与右侧子标题之间出现异常大空档；手机及普通浏览器不明显。 |
| 2 | **证据** | 当日归档的 514px 子目录表格把左列自动扩到约 141px；`AI 前沿`文字约 40.6px，空档约 100.4px，另两行空档约 93px。07-16、07-21 同结构因右侧内容不同，空档分别约 26–33px、46–53px。 |
| 3 | **根因** | 子目录使用 100% 宽双列表格，但没有 `table-layout:fixed`，标题 `td` 也没有 HTML/CSS 宽度。Word HTML 引擎按右侧内容反推列宽，因此内容变短时左列变宽。B039 没改此处，只是现有测试未锁列宽。 |
| 4 | **修复** | 子目录 table 增加专属 class 与 `table-layout:fixed`；标题列同时声明 `width="64"` 和 `width:64px`，移除原 10px 右 padding；右列占剩余宽度并继续允许自然换行。 |
| 5 | **视觉量化** | 只读回放 07-16、07-21、07-22 三份归档，64px 标题列下 `AI 前沿`空档约 23.4px，`社区动态 / 今日热点`约 16px，不再随右侧标签数量漂移。 |
| 6 | **安全边界** | Preserve 模式，不改栏目、文案、字体、颜色、锚点、条目、正式 archive/shown/rank/sent ledger；修正版仅允许一次性投递到用户指定的单一收件人。SMTP 失败或结果未知时禁止自动重试。 |
| 7 | **验收** | 用用户给出的三行真实计数做 RED→GREEN；renderer 全套、typecheck、build、质量门禁、独立 Guardian 与 peer review 通过后才合入和发送。 |

## TDD 证据

- **RED：** 新增用户示例矩阵后，renderer `64/65`；唯一失败是缺少 fixed-layout 子目录与 64px 标题列。
- **GREEN：** 最小结构修复后 renderer `65/65`。
- **一致性锁：** 不使用 `nowrap`、`&nbsp;` 空白占位或新的任意视觉 token；右侧链接继续换行，避免复发 Outlook 灰块与溢出。

## 运行态与发送

代码合入和项目重启不等于 Outlook 实机视觉通过。最终视觉以用户指定邮箱中的 Classic Outlook 实收为准；单收件人补发必须使用独立原子 marker，不调用生产 `send-now`，也不覆盖正式日报账本。

2026-07-22 运行闭环：最终 `039b9c98` 已合入并推送 `dev`；项目 API/Web 换新进程后均为 HTTP 200，scheduler 恢复 `9 cron / 2 startup` 与 leader term 45。exact-recipient 修正版只投递指定单人并明确返回成功，outbound ledger `38→39` 且 operation 恰好一条；原 archive、shown、rank、sent ledger 与 health 保持不变。真实 Classic Outlook 视觉仍待收件人确认。

## Quality Gate

- renderer + daily-digest job：`105/105`；全量 `pnpm test`：exit 0。
- typecheck、改动文件 lint、docs/check、build、`git diff --check`：通过。
- 2026-07-22 真实归档重放：可见文本、67 个 href 及顺序、55 个 displayed ID、6 个 rest ID、Markdown 全等；六份正式归档哈希不变。
- B039 回归合同：四个独立榜种标题、四张显式 sans 内层表与 21 个仓库文字节点全部通过。
- 独立 Acceptance Guardian：PASS；peer review：Approved，P0/P1/P2/P3 = 0/0/0/0。
