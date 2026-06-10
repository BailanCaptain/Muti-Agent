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

**Tab B 「Worktree」**
- worktree 列表：`git worktree list` 全量 + 每个的 preview 运行状态（F024 port registry：:3100+/:8800+ 端口、起/停）
- 选中某个 worktree → 进展摘要：分支、最近 commits、相对 dev 的 diff stat
- **手动编译按钮**：触发该 worktree 后端重启拾取新代码（正确注入 `API_PORT` + `SQLITE_PATH`，杀残留孤儿进程），前端 next dev 本身热更新无需编译
- 操作反馈：进行中 / 成功 / 失败 + 日志尾部可见

## Acceptance Criteria

> 草案，讨论收敛 + Design Gate 后细化定稿。

- [ ] AC1: RuntimeLog 一级 tab 新增「项目目录」，树形展示项目结构，目录可展开/收起，点击文件可看内容（只读）
- [ ] AC2: 文件 list/read 走同一 containment 安全原语（与 wiki content 端点同源），树外路径/symlink 逃逸返回 4xx；secrets（`.env*` 等）不可读
- [ ] AC3: RuntimeLog 一级 tab 新增「Worktree」，列出全部 worktree + 各自 preview 运行状态（端口/起停）
- [ ] AC4: 选中 worktree 可看进展摘要：分支名、最近 commits、相对 dev 的 diff stat
- [ ] AC5: 手动编译按钮：重启该 worktree preview 进程组拾取新代码（重走 mount-skills→tsc shared→tsc api→tsx watch 全链，env 注入正确，孤儿进程先清理），按钮态有进行中/成功/失败反馈 + 日志尾部可见
- [ ] AC6: 编译/重启/启动操作物理上碰不到主库进程与主库数据（:8787 / :3000 / 主 SQLite 保护），有边界测试
- [ ] AC7: 未运行的 worktree 可从 UI 直接启动 preview（端口走 F024 registry 动态分配），同样受 AC6 边界约束

## Dependencies

- **F024** Worktree 愿景验收基础设施：port registry / preview 启动链路 / shutdown worker（`scripts/worktree-preview.ts`、`scripts/worktree-port-registry.ts`）
- **F027** RuntimeLog 容器宿主（一级 tab 扩展位）+ wiki containment 读原语（复用源）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 交付顺序 | Tab A 先 / Tab B 先 | **Phase 1 = Worktree tab，Phase 2 = 项目目录** | Worktree 痛点更尖（看不到进展+拿不到新代码）；项目目录交互简单可快速跟上。黄仁勋建议，小孙 /goal 放权 |
| "手动编译"语义 | 仅 tsc / 重启进程组 | **重启该 worktree preview 进程组** | `dev:api` 链中 shared tsc、skills 挂载只在启动跑一次，tsx watch 盖不住；重启=重走全编译链，顺带清孤儿进程，也覆盖 `NEXT_PUBLIC_*` 改动场景 |
| 文件访问权限 | 只读 / 可编辑 | **只读** | 编辑仍走 agent；最小权限面 |
| secrets 边界 | 置灰 / 隐藏 | **`.env*` / auth / token 类直接隐藏** | 不给泄露面，置灰仍暴露存在性与文件名 |
| 项目目录的根 | 仅主仓 / 可切换 | **可切换：主仓 + 任一 worktree** | 与 Worktree tab 联动（选中分支一键跳文件树） |
| UI 启动 preview | 只管已运行 / 可启动 | **未运行可从 UI 启动**（AC7） | 自助闭环：小孙不需要找 agent 起 preview |
| Design Gate | — | **已过**：小孙看交互草图初稿后 /goal "做吧"放行；附加要求德彪 review 本文档愿景对齐 | 小孙原话（2026-06-11 /goal）："做吧 按照我们的skills流程走 一直往下推……这个feature文档我觉得就要找德彪讨论下 是否符合我的愿景" |

## Open Questions（已收口）

1. ~~优先级~~ → Worktree tab 先（Design Decisions）
2. ~~"手动编译"语义~~ → 重启 preview 进程组（Design Decisions）
3. ~~项目目录的根~~ → 可切换（Design Decisions）
4. ~~只读够用否~~ → 只读（Design Decisions）
5. ~~secrets 边界~~ → 直接隐藏（Design Decisions）
6. 小孙"加几块内容"仅列两块，第三块未提及 → 按两块执行；如有新想法另立讨论

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-06-11 | Kickoff（小孙口述 RuntimeLog 未来拓展两项需求） |
| 2026-06-11 | 讨论收口 + Design Gate 放行（小孙 /goal 放权全流程推进，点名德彪审文档愿景对齐） |

## Links

- Discussion: 本文件 Why（小孙原话）+ Open Questions 章节（采访进行中）
- Plan: （待 writing-plans）
- Related: F024, F027

## Evolution

- **Evolved from**: F027（RuntimeLog 一级 tab「未来」扩展位的第一次兑现）
- **Blocks**: 无
- **Related**: F024（worktree preview 基础设施被 Tab B 包装为 UI 能力）
