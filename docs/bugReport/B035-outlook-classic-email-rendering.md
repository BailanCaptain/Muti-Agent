---
id: B035
title: F037 日报在经典 Outlook 桌面端视觉失真
status: verification
related: F037
reported: 2026-07-16
---

# B035 — F037 经典 Outlook 邮件渲染失真

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | 小孙在手机 Outlook 中看到的 2026-07-16 正式日报符合已批准视觉，但在 Windows 经典 Outlook（顶部有“文件”选项卡）打开时版式明显不同且“太难看”。 |
| 2 | **证据** | 实发 HTML 有 49 处 `border-radius`、148 处 `div` padding/margin、64 张嵌套表格、169 处百分比行高，且 MSO 条件分支、VML、`bgcolor` 均为 0；Windows 缺少 `Songti SC`/`PingFang SC`，标题回退为微软雅黑。微软官方说明经典 Outlook 使用 Word HTML 引擎，标准 CSS 间距与行高会不一致。 |
| 3 | **假设** | H1：上一轮只以 Chromium 验收，把浏览器兼容误当作 Outlook 兼容；Word 引擎忽略圆角并重排 `div` 间距/行高。H2：缺少 96 DPI 归一化与 Windows 中文字体导致宽度、标题气质进一步偏移。 |
| 4 | **诊断策略** | 对照 `94ec679` 最近视觉 diff 与微软 Outlook Classic 限制；用合同测试锁定 MSO/96-DPI/字体/像素行高/表格背景与 table/td 间距；用 2026-07-16 原归档只读重渲染，对正文、ID、链接、预算和归档不可变性做机器校验。 |
| 5 | **超时策略** | 本机 Outlook/Word 因 `AppVIsvSubsystems64.dll` 损坏无法启动，不能伪造“实机已验”；保留 `.eml` 证据并以仅发本人邮箱的真实投递完成最终人工验收，结果不明时绝不自动重发。 |
| 6 | **预警策略** | 若必须改正文、选材、链接、定时幂等、运行配置，或只能通过重跑抓取/LLM 重发，立即停止；这些都超出“只修邮件前端”的授权。 |
| 7 | **用户可见修正** | 已明确告知这是 Windows 经典 Outlook 兼容漏项；不另做“丑的降级版”，延续当前配色、深色刊头、字号层级、卡片结构与留白，只为 Word 引擎补 MSO/VML 兼容。修正版以新主题仅重发到 `sundengjun1@huawei.com`。 |
| 8 | **复现验收** | RED：原 renderer 缺 MSO 96-DPI、Outlook 行高/字体/table 间距合同；二轮 RED 又锁定关键 `div/span` padding、长 token 撑宽和兼容层体积膨胀；独立 review 复现现代客户端长 token 溢出，独立验收随后纠正预算 fixture：生产真上限是 34 篇正文 + 22 个仓库 + 4 个播客共 60 条，最碎合法分组原输出 139,588 bytes。最终 review 又以 emoji 截断边界和单条 40,000 汉字标题打出两个 P2。GREEN：renderer + job 专项通过；摘要按 Unicode code point 截断，不会切开代理对；原归档重渲染后 Markdown、可见正文、52 个展示 ID、62 个 href 顺序不变，HTML 78,458 bytes，且归档/ledger hash 不变；渲染层只在移除速览后仍超 98KiB 时逐级缩短 HTML 摘要，标题、链接、条目集合与 Markdown 不变，60 条 publication 路径为 97,673 bytes；终态若仍超预算则在归档/SMTP 前 fail-closed。双栏、整宽、GitHub 长 token 在现代客户端均无溢出，Outlook 条件样式继续使用 `break-all`。真实 Classic Outlook 视觉待修正版投递后由小孙确认。 |

## Bug Report 六件套

1. **报告人**：小孙；2026-07-16 在 Windows 经典 Outlook 查看第二封正式日报时发现；随后明确要求修正版只重发到 `sundengjun1@huawei.com`，并要求 Outlook 延续当前视觉而不是整体降级。
2. **Bug 现象**：同一封 2026-07-16 正式日报在手机 Outlook 保持暖白编辑部视觉，在 Windows 经典 Outlook 中却出现圆角消失、行高/留白失真、标题字体和卡片层级明显变丑。
3. **复现步骤**：在手机 Outlook 打开正式邮件作为批准基线；再在 Windows 经典 Outlook（Word HTML 引擎）打开同一邮件，比较深色刊头、每日简报标题、速览、双栏卡片、GitHub 数据行与页脚间距。原 HTML 可静态复现出 49 处无兜底圆角、169 处百分比行高、0 个 MSO/VML 分支和 0 个关键 `bgcolor`。
4. **根因分析**：上一轮验收只覆盖 Chromium/窄屏，没有覆盖 Word HTML 引擎。经典 Outlook 忽略标准 `border-radius`，对百分比行高、`div/span` padding、nowrap/word-break 和 Windows DPI/字体回退处理不同；renderer 又没有 MSO 条件头、96 DPI、VML 或 Windows 中文衬线落点，故移动端正常而桌面端失真。
5. **修复方案**：保持现有颜色、深色刊头、字号层级与卡片结构；增加 MSO 96-DPI/table spacing/exact line-height，改用像素行高和 `bgcolor`，Windows 标题回退到 SimSun；刊头用动态高度 VML roundrect，MSO 内层背景透明；关键刊头、焦点徽标、卡片、GitHub、速览、告警与页脚间距迁到 presentation table/td；hero/wide/col 卡片扁平化以回收兼容开销；仅对双栏内连续 ASCII ≥13 的标题添加 Outlook 条件 `word-break:break-all`，不再注入会污染复制内容的零宽字符。
6. **验证方式**：两轮 TDD RED→GREEN；专项 renderer 与 job 回归；2026-07-16 archive-only 重渲染断言主题、Markdown、可见文本、publication/displayed/rest IDs、href 顺序、98KB 预算和八个归档/ledger 文件 hash；生成 `outlook-preview.eml`。本机 Office 损坏使真实 Outlook 截图不可得，因此最终一项由仅投递 `sundengjun1@huawei.com` 的修正版实机确认，SMTP 结果不明时不自动重试。
