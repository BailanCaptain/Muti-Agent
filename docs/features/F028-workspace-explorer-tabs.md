---
id: F028
title: RuntimeLog 工作区拓展：项目目录浏览 + Worktree 浏览与手动编译
status: spec
owner: 黄仁勋
created: 2026-06-11
---

# F028 — RuntimeLog 工作区拓展：项目目录浏览 + Worktree 浏览与手动编译

## Why

小孙对项目文件和 worktree 进展目前是"盲"的——唯一获取通道是跟 agent 聊天问。worktree 上做得怎么样、改了什么文件、preview 是不是最新代码，全部依赖转述，没有自助可视通道。

RuntimeLog 容器（F027 落地）一级 tab 明确预留了未来扩展位（`runtime-log-store.ts` 注释："未来扩展：LVL1_ITEMS.push(...)"，UI 上有「日志 · 未来」占位）。本 feature 是这个扩展位的第一次兑现：把**工作区可见性**做成新 tab，让小孙自助看、自助驱动。

**小孙原话（2026-06-11）**：
1. "我希望有一个项目目录 可以看到我们项目结构，再项目结构里是可以正常点击的就跟我在桌面一样，点击某个文件可以看到文件内容"
2. "我希望加一个worktree浏览，可以选择某个worktree ，而且可以手动编译worktree的代码，不然每次我只能跟你聊，我不知道worktree上做的怎么样了，实时的前端可以显示，改了后端需要编译的话我可以手动编译"

## What

RuntimeLog 容器新增两个一级 tab：

**Tab A 「项目目录」**
- 树形展示项目结构，目录可展开/收起（懒加载），交互像桌面文件管理器
- 点击文件 → 展示文件内容（只读）
- 文件读取必须复用 wiki content 端点**同一 containment 读原语**（list/read 同源 —— 德彪 6 轮 review 教训），树外路径/symlink 逃逸 fail-closed
- 树根可切换：主仓 / 任一 worktree

**Tab B 「Worktree」**
- worktree 列表：`git worktree list` 全量 + 每个的 preview 运行状态（F024 port registry 端口 + 端口存活探测 + 进程所有权状态）
- 选中某个 worktree → 进展摘要：分支、最近 commits、相对 dev（merge-base 基准）的 diff stat、**未提交工作**（staged / unstaged / untracked 计数）
- **「编译后端」按钮（小孙原话的"手动编译"）**：只重启该 worktree 的 API 进程链（重走 `mount-skills → tsc shared → tsc api → tsx watch`），**不中断**正在热更新的 next dev 前端
- **「重启整个 preview」次级操作**：API + Web 全组重启（覆盖 `NEXT_PUBLIC_*` 变更等需要重起前端的场景）
- **「打开前端」**：一键新窗口打开该 worktree 的实时前端 preview URL（小孙原话"实时的前端可以显示"的入口）
- 未运行的 worktree 可从 UI 直接启动 preview
- 操作反馈：进行中 / 成功 / 失败 + 日志尾部可见

## Acceptance Criteria

> r2（德彪 codex r1 NEEDS-WORK 9 findings 修订后）。

**Tab A 项目目录**
- [ ] AC1: RuntimeLog 一级 tab 新增「项目目录」，树形展示项目结构（根可切：主仓/任一 worktree），目录懒加载展开/收起，点击文件可看内容（只读）
- [ ] AC2: 文件 list/read 走同一 containment 安全原语（与 wiki content 端点同源 `readContainedFile`：realpath containment + 单 fd + nlink>1 拒），树外路径/symlink/junction 逃逸返回 4xx；**精确 denylist**（见 Design Decisions D8）整树隐藏且 content 端点对其 404（不暴露存在性）；资源上限：二进制（NUL 嗅探）拒、单文件 >512KB 截断标记、单目录条目上限 1000、读取超时 5s

**Tab B Worktree**
- [ ] AC3: RuntimeLog 一级 tab 新增「Worktree」，列出全部 worktree + 各自 preview 状态（registry 端口、端口存活探测、进程所有权：UI 管理 / 非 UI 管理 / 未运行）
- [ ] AC4: 选中 worktree 可看进展摘要：分支名、HEAD、最近 10 commits、相对 dev 的 diff stat（基准 `merge-base dev HEAD`）、未提交工作计数（staged / unstaged / untracked）
- [ ] AC5: 「编译后端」按钮：只重启该 worktree API 进程链（mount-skills→tsc shared→tsc api→tsx watch，env 子进程注入），next dev 前端进程不动；「重启整个 preview」为独立次级操作（API+Web 全组）；两者均有进行中/成功/失败按钮态 + 日志尾部可见
- [ ] AC6: 控制面安全合同：worktree name→root 仅由服务端从 `git worktree list` 解析（调用方不可传 cwd/命令/env）；spawn 全程无 shell 字符串拼接（args 数组）；操作端点 POST + 同源校验（Origin/Host 不匹配拒）；每次操作写审计记录（time/action/worktree/result → `.runtime/worktree-preview-ui/audit.log`）；操作物理上碰不到主库进程与主库数据（:8787/:3000/主 SQLite 端口断言 + 边界测试）；信任模型 = localhost 单用户 dev（与 repo 既有端点一致，不引入账号体系）
- [ ] AC7: 未运行的 worktree 可从 UI 启动 preview（端口走 F024 registry 动态分配），同受 AC6/AC9 约束
- [ ] AC8: 每个 running worktree 提供「打开前端」一键入口（新窗口打开 `http://localhost:<webPort>`），端口来自 registry 不可手填
- [ ] AC9: 进程所有权：UI 编排只杀 (pid + 进程 birth time) 与自己状态文件（`.runtime/worktree-preview-ui/<name>.json`）匹配的进程树；端口被**非 UI 管理**进程占用时拒绝操作并提示先手动停止（绝不按端口/进程名杀）；主 API 启动时 reconcile 状态文件（pid+birthTime 失配 → 标记 stale 清理记录，不杀进程）；UI 路径全程不创建/改写/删除任何 `.env*` 文件（环境仅子进程 env 注入；CLI 路径保留 F024 现状）
- [ ] AC10: 同一 worktree 操作单飞：并发第二发返回 409 operation_in_progress（拒绝不排队）

## Dependencies

- **F024** Worktree 愿景验收基础设施：port registry（`claimPorts`/`releasePorts` + proper-lockfile）、`buildPreviewEnv`（复用为子进程 env 注入源）、shutdown-worker
- **F027** RuntimeLog 容器宿主（一级 tab 扩展位）+ `wiki/path-containment.ts#readContainedFile`（复用源）

## Design Decisions

| # | 决策 | 选项 | 结论 | 原因 |
|---|------|------|------|------|
| D1 | 交付顺序 | Tab A 先 / Tab B 先 | **Phase 1 = Worktree tab，Phase 2 = 项目目录** | Worktree 痛点更尖；项目目录交互简单可快速跟上。黄仁勋建议，小孙 /goal 放权 |
| D2 | "手动编译"语义 | 仅 tsc / 重启 API 链 / 整组重启 | **「编译后端」= 只重启 API 进程链**；整组重启为独立次级操作 | 德彪 r1 P2-5：小孙原话是"后端需要编译"，整组重启会中断他正看着的实时前端；API 链重启已覆盖 shared tsc/skills 挂载/后端新代码 |
| D3 | 文件访问权限 | 只读 / 可编辑 | **只读** | 编辑仍走 agent；最小权限面；德彪 r1 判定"不算缩水愿景" |
| D4 | 项目目录的根 | 仅主仓 / 可切换 | **可切换：主仓 + 任一 worktree** | 与 Worktree tab 联动 |
| D5 | UI 启动 preview | 只管已运行 / 可启动 | **未运行可从 UI 启动**（AC7） | 自助闭环 |
| D6 | 进程模型 | 复用 supervisor 进程 / 编排器直管两子进程 | **主 API 编排器分别 spawn dev:api 与 dev:web（detached + 日志落盘 + 状态文件记 pid+birthTime+token）** | 「编译后端」需要单杀 API 子进程；supervisor 整组模型做不到靶向重启（德彪 r1 P2-5/P2-6 连锁结论） |
| D7 | 杀进程依据 | 端口 listener / pid+birthTime 所有权 | **只杀 (pid+birthTime) 与状态文件匹配的进程树**；非 UI 管理 listener → 拒绝+提示 | 德彪 r1 P1-3：端口杀可能误杀无辜进程；与既有 StartTime safe-kill 经验一致 |
| D8 | secrets 边界 | 模糊"类" / 精确 denylist | **精确 denylist**：目录 `node_modules` `.git` `.next` `.npm-cache` `.worktrees` `.runtime` `.agents` `data` `.codex` `.gemini` `.obsidian`；文件 `.env*` `auth.json` `*.pem` `*.key` `*.p12` `*.pfx` `id_rsa*` `*.token` `.npmrc`；**隐藏**（list 不出现 + content 404） | 德彪 r1 P2-7："auth/token 类"不可测试；隐藏优于置灰（不暴露存在性） |
| D9 | UI 路径 dotenv | 复用 F024 prepareDotenv / 零写入 | **UI 路径零 `.env*` 写入**，环境全部子进程 env 注入（Next.js process.env 优先于 .env 文件）；CLI 路径保留 F024 现状 | 德彪 r1 P1-4：运行时自动改 `.env*` 踩铁律 3；CLI 是人工操作不受影响 |
| D10 | 控制面信任模型 | 引入 auth / localhost 单用户 + 同源 + 审计 | **沿用 repo localhost 单用户模型**，加 POST+同源校验+审计日志，不建账号体系 | 德彪 r1 P1-2 要求安全合同；与 repo 既有写端点信任模型一致，账号体系超出本 feature |
| D11 | Design Gate 状态 | 已过 / 条件放行 | **条件放行**：小孙草图放行 + 点名德彪愿景审；德彪 r1 NEEDS-WORK 9 findings 修订中，复审 GO 才算过 | 德彪 r1 P2-9：小孙明确把德彪愿景审纳入门 |

## Open Questions

1. ~~优先级~~ → D1
2. ~~"手动编译"语义~~ → D2（r1 改判：API 链靶向重启）
3. ~~项目目录的根~~ → D4
4. ~~只读够用否~~ → D3（德彪判定不算缩水）
5. ~~secrets 边界~~ → D8（精确 denylist）
6. ~~并发/进程归属/排除清单~~ → D6/D7/D8/AC9/AC10（德彪 r1 后收口）
7. 小孙"加几块内容"仅列两块，第三块未提及 → 按两块执行；如有新想法另立讨论

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-06-11 | Kickoff（小孙口述 RuntimeLog 未来拓展两项需求） |
| 2026-06-11 | 讨论收口 + Design Gate 条件放行（小孙 /goal 放权全流程推进，点名德彪审文档愿景对齐） |
| 2026-06-11 | 德彪 codex r1 愿景审 **NEEDS-WORK**（4 P1 + 5 P2 + 愿景对齐表 3 ❌）；9 findings 全接，AC 重构为 10 条，Design Decisions 扩为 D1-D11 |

## Links

- Discussion: 本文件 Why（小孙原话）+ Open Questions 章节
- Plan: `docs/plans/F028-workspace-explorer-tabs-plan.md`
- Review: 德彪 r1 `.runtime/reviews/F028-doc-review-codex-r1.md`（scratch，不入库）
- Related: F024, F027

## Evolution

- **Evolved from**: F027（RuntimeLog 一级 tab「未来」扩展位的第一次兑现）
- **Blocks**: 无
- **Related**: F024（worktree preview 基础设施被 Tab B 包装为 UI 能力）
