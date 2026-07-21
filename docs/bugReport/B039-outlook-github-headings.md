---
title: F037 Outlook 开源榜单字体与标题层级不一致
status: verification
related: F037
reported: 2026-07-22
---

# B039 — F037 Outlook 开源榜单字体与标题层级不一致

Related: F037

## 小孙原话

> 日报的前端，开源榜单那里字体和上面好像不一致，Outlook 版的。增长榜 · 今日 · 3、周榜 · 6 这些标题单独摘出来吧，和上面的科技从业者 · 6 条、推理 · 2 条这些小标题一样保持一致。

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | Windows 经典 Outlook 中，“开源榜单”的字体与上方 AI/X 子栏不一致；“增长榜 · 今日 · 3”“周榜 · 6”等榜种标题嵌在榜单卡内，没有复用“科技从业者 · 6 条”“推理 · 2 条”的独立子标题层级。 |
| 2 | **证据** | 小孙查看最新日报后的实机反馈；2026-07-21 生产归档重渲染确认 GitHub 独有嵌套 `card-content-table`，旧版四个榜种标题均位于卡内，而 AI/X 子栏走独立 `subHeading()`。 |
| 3 | **假设** | H1：GitHub 榜单使用独立的行式 renderer，标题/数据行没有继承通用卡片的 Outlook 字体规则。H2：榜种标题由榜单卡内部生成，而 AI/X 子栏标题走独立 section-group heading，导致层级与间距不一致。 |
| 4 | **诊断策略** | 逆向追踪 GitHub publication → renderer HTML；完整对照通用子标题 renderer；用 2026-07-21 publication 生成结构快照，量化 font-family、边框、字号、间距与 DOM/table 层级差异。 |
| 5 | **超时策略** | 20 分钟仍无法映射到单一 renderer 分支，则把生产归档缩成最小 GitHub + AI/X fixture，逐层二分渲染。三轮修复无效则停止补丁并重新审视邮件 table 骨架。 |
| 6 | **预警策略** | 若修改会改变 GitHub 排序、条目集合、链接、98 KiB 预算或非 Outlook 客户端布局，立即 fail-closed；不修改 `.env`、runtime 配置或历史归档。 |
| 7 | **用户可见修正** | Preserve 模式：开源榜单正文统一到上方字体；四个榜种标题移到卡片外，复用现有子标题视觉，保持“开源榜单”总名、四榜名称与内容不变。 |
| 8 | **复现验收** | RED→GREEN 锁定字体栈与独立标题结构；重放 2026-07-21 归档，断言显示条目 ID、顺序、标题、链接和 Markdown 不变；Chromium 截图做结构证据，真实 Classic Outlook 以次日实收观察为最终视觉证据。 |

## Design Gate

- 类型：前端 UI/UX，现有 F037 的视觉修正，不新立 Feature。
- 模式：Preserve。
- 已确认方向：小孙已明确指定以“科技从业者 · 6 条 / 推理 · 2 条”小标题为参照；无需另行确认。
- Non-goals：不改 GitHub 准入、排序、跨日状态、四榜名称、条目内容、链接、邮件宽度或整体配色。

## 根因

GitHub 榜单是唯一在外层列表卡中再次嵌套 `card-content-table` 的板块。旧实现只在外层 `outlook-list-card` 指定 sans 字体，序号、仓库链接、数据行和摘要均依赖字体跨嵌套 table 继承；Classic Outlook 的 Word HTML 引擎不会可靠保留这段继承。与此同时，榜种标题由 `ghListCard()` 在卡内单独拼接，未走 AI/X 已有的 `subHeading()`，因此视觉层级天然不一致。

## 修复

- `ghListCard()` 只渲染仓库列表，不再拼接卡内 `◆ 榜名 · N`。
- GitHub 渲染循环在每张列表卡之前复用现有 `subHeading()`，四榜统一显示“榜名 · N 条”。
- 内层列表 table 显式使用现有 `SANS` 字体栈，并给序号、仓库链接、meta、摘要直接挂 `digest-sans`，不依赖 Classic Outlook 跨 table 继承。
- 未改 GitHub publication、排序、caps、状态、链接、Markdown、邮件宽度和颜色 token。

## 验证证据

- TDD RED：新增两项 B039 测试后，renderer 初跑 `64` 项中 `2` 项按预期失败，分别咬住独立标题与序号字体合同。
- TDD GREEN：renderer + daily-digest job 定向回归 `104/104` 通过。
- 2026-07-21 生产归档只读重放：`69` 个 href 顺序、`50` 个展示条目、`2` 个 rest 条目和 Markdown 全部逐项一致；历史归档 hash 未变化。
- 重渲染 HTML 为 `92,534 bytes`，低于 `98 KiB` 上限 `100,352 bytes`，余量 `7,818 bytes`；正式最大预算测试仍通过。
- Playwright 注入 MSO 条件样式后的 Outlook 结构截图：旧版 `0` 个独立 GitHub 子标题 / `4` 个卡内旧标题；新版 `4` 个独立子标题 / `0` 个卡内旧标题。仓库链接与内层 table 计算字体均为 `Microsoft YaHei, Arial, sans-serif`。
- 全仓门禁：typecheck、build、lint 均 exit `0`；API 全量首轮 `4690 pass / 9 fail` 与未改 `dev` 精确同集，均由系统 `bash` 错指损坏 WSL 引起，进程级改用 Git Bash 后这 `9/9` 通过；随后全量 `4698 pass / 1` 个 Windows 临时文件 rename `EPERM`，原症状测试立即复跑 `16/16` 通过；组件 `903/903` 通过。

## 待观察

真实 Classic Outlook 最终观感以 2026-07-22 07:30 实收邮件为准；同时只读检查发送账本、归档、全部 source-health 与 X 分账号失败日志。监控不得自动补发、改配置或重启电脑。
