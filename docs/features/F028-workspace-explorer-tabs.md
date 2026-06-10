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
- [ ] AC5: 手动编译按钮：重启该 worktree 后端（env 注入正确，孤儿进程先清理），按钮态有进行中/成功/失败反馈
- [ ] AC6: 编译/重启操作物理上碰不到主库进程与主库数据（:8787 / :3000 / 主 SQLite 保护），有边界测试

## Dependencies

- **F024** Worktree 愿景验收基础设施：port registry / preview 启动链路 / shutdown worker（`scripts/worktree-preview.ts`、`scripts/worktree-port-registry.ts`）
- **F027** RuntimeLog 容器宿主（一级 tab 扩展位）+ wiki containment 读原语（复用源）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| （待 Design Gate） | | | |

## Open Questions（讨论中）

1. 优先级：项目目录 vs worktree 浏览，哪个先交付？
2. "手动编译"语义：= 重启 worktree 后端进程拾取新代码？还是含真 build 产物？
3. 项目目录的根：只看主仓，还是可切换到某个 worktree 的根浏览（与 Tab B 联动）？
4. 文件内容只读是否够用（默认不做编辑，编辑仍走 agent）？
5. secrets 边界：`.env` / auth 类文件在树中置灰不可读，还是直接隐藏？

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-06-11 | Kickoff（小孙口述 RuntimeLog 未来拓展两项需求） |

## Links

- Discussion: 本文件 Why（小孙原话）+ Open Questions 章节（采访进行中）
- Plan: （待 writing-plans）
- Related: F024, F027

## Evolution

- **Evolved from**: F027（RuntimeLog 一级 tab「未来」扩展位的第一次兑现）
- **Blocks**: 无
- **Related**: F024（worktree preview 基础设施被 Tab B 包装为 UI 能力）
