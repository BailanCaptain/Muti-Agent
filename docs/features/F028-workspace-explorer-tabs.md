---
id: F028
title: RuntimeLog 工作区拓展：项目目录浏览 + Worktree 浏览与手动编译
status: done
owner: 黄仁勋
created: 2026-06-11
phase1_completed: 2026-06-13
reopened: 2026-06-13  # 续作本轮交付：worktree 清理 MVP（AC11-12）。脱管 preview 接管恢复=D 区/AC13 转 OQ8 待小孙拍，不在本轮
completed: 2026-06-14  # 续作 AC11-12 merged d528d40 + pushed origin/dev。清理按钮 live spot-click=小孙首次使用即验收（control:true 仅主 UI 连真库，不自动跑）；AC13/OQ9 待小孙拍
---

# F028 — RuntimeLog 工作区拓展：项目目录浏览 + Worktree 浏览与手动编译

## Why

小孙对项目文件和 worktree 进展目前是"盲"的——唯一获取通道是跟 agent 聊天问。worktree 上做得怎么样、改了什么文件、preview 是不是最新代码，全部依赖转述，没有自助可视通道。

RuntimeLog 容器（F027 落地）一级 tab 明确预留了未来扩展位（`runtime-log-store.ts` 注释："未来扩展：LVL1_ITEMS.push(...)"，UI 上有「日志 · 未来」占位）。本 feature 是这个扩展位的第一次兑现：把**工作区可见性**做成新 tab，让小孙自助看、自助驱动。

**小孙原话（2026-06-11）**：
1. "我希望有一个项目目录 可以看到我们项目结构，再项目结构里是可以正常点击的就跟我在桌面一样，点击某个文件可以看到文件内容"
2. "我希望加一个worktree浏览，可以选择某个worktree ，而且可以手动编译worktree的代码，不然每次我只能跟你聊，我不知道worktree上做的怎么样了，实时的前端可以显示，改了后端需要编译的话我可以手动编译"

**续作需求（小孙原话 2026-06-13）**：
3. "worktree只有显示 有没有清理的 如果我的Feature做完了 他会自动在我的worktree列表消失吗"
4. "我觉得我提出的那个应该再F028里面做完"（纳入 F028，不另立项）

**实战触发**：2026-06-13 主线合 dev 后，黄仁勋为让 registry fix 生效在 worktree 手动 `tsx watch` 起 8801（绕过 UI 编排），小孙在主 UI 重启撞 `descendant` 预检死锁、日志空、无自助恢复——印证"脱管 preview 无接管路径"是真实缺口。**本轮续作仅交付 worktree 清理（C 区 / AC11-12）**；脱管 preview 接管恢复（D 区 / AC13）安全方案未决（CommandLine≠cwd），转 OQ8 待小孙拍，**不在本轮**。

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
- **「打开前端」**：在面板下方**内嵌 iframe** 显示该 worktree 的实时前端（小孙原话"实时的前端可以显示"的入口；验收期修正——小孙："我不想要打开前端的时候 打开一个新的网页 我想要嵌在下面"）
- 未运行的 worktree 可从 UI 直接启动 preview
- 操作反馈：进行中 / 成功 / 失败 + 日志尾部可见

**续作 · Worktree 清理（2026-06-13 纳入 · MVP 收敛）**

> **scope（小孙 2026-06-13『继续吧不需要过度设计了 只做必须做的』）**：只做小孙原话直接对应的「worktree 清理 + 清完从列表消失」。德彪 doc 审 r1→r3 提出的企业级删除装置（resourceId 哈希身份、tombstone 崩溃恢复事务、数据三分类、managed-root 逐步重验、双 registry 全删、分支 OID CAS）一律**收敛删除**——删一个开发态 worktree 的小工具不背这套。真正必须的安全=复用现有 guard（绝不按端口杀 / git 内建保护 / 只在 worktree 内删 / 安全门挡未保存工作）。D 区脱管 takeover 仍待小孙确认（OQ8），本轮不做。

- 列表每行加合并状态：相对 dev 的 ahead/behind commit 数 + "本地 dev 已包含提交" **advisory 徽标**（best-effort 提示，见 D14；注：未提交工作计数由 summary 端点提供见 AC4，不在合并状态里）；据此显示「本地 dev 已包含提交」提示（小孙要"列表一眼看出可清理"）。**清理按钮本身对任何非主仓 worktree 可用，徽标只 advisory 不作硬门**（见 AC11/AC12：merge-gate squash 后 is-ancestor=false，硬门会让做完的 feature 反而清不掉）
- 「清理」按钮：对一个 worktree 走 停 preview（复用 AC9 现有 descendant 预检 kill，绝不按端口/名杀）→ **预删可再生构建产物**（仅 node_modules / .next，避免 Windows file-busy）→ `git worktree remove`（**无 --force**）**删除整个 worktree（含其自造运行数据：.runtime 隔离 SQLite、.agents/acceptance uploads 等——小孙 2026-06-14「worktree 造的数据可删」，实测 remove 删 ignored 数据、仅对 untracked 非 ignored 的"用户未保存工作"才拒）**→ `git branch -d`（git 内建合并保护，未合并就拒、保留分支）→ 释放端口（复用 releasePorts）→ 从列表消失。**git worktree remove 非原子**（中途失败仍注销，留半态），故对**不可再生**的 `.env*.backup-by-preview`（preview 未恢复的用户原配置）由安全门提前拒绝清理，不让它进删除路径（D15）
- 回答小孙"做完会自动消失吗"：不会全自动（列表实时来自 `git worktree list`），改为**一键清理 + 可清理标记 + 清完即时从列表消失**（准自动体验）
- 撞 foreign（非 UI 启动）preview：不自动 kill，直接中止 + 人话提示"该 preview 脱管，请人工停进程后再清理"

## Acceptance Criteria

> 主线 AC1-10：德彪 r1（9 findings）→ r8 GO 定稿（见 Timeline）。续作**本轮交付 AC11-12（worktree 清理 MVP）**；AC13（D 区脱管 takeover）转 OQ8 待小孙拍、**不在本轮**。见下方 C 区段。

**Tab A 项目目录**
- [x] AC1: RuntimeLog 一级 tab 新增「项目目录」，树形展示项目结构（根可切：主仓/任一 worktree），目录懒加载展开/收起，点击文件可看内容（只读）
- [x] AC2: 文件 list/read 走同一 containment 安全原语（与 wiki content 端点同源 `readContainedFile`：realpath containment + 单 fd + nlink>1 拒），树外路径/symlink/junction 逃逸返回 4xx；**精确 denylist**（见 Design Decisions D8）整树隐藏且 content 端点对其 404（不暴露存在性）；资源上限**在原语层生效**：`readContainedFile` 扩展可选 `maxBytes`（同一 fd 上限读，超限截断标记，杜绝先整读后截断的内存放大；加法参数，既有调用方零改动）、二进制（NUL 嗅探）拒、单目录条目上限 1000

**Tab B Worktree**
- [x] AC3: RuntimeLog 一级 tab 新增「Worktree」，列出全部 worktree + 各自 preview 状态（registry 端口、端口存活探测、进程所有权：UI 管理 / 非 UI 管理 / 未运行）
- [x] AC4: 选中 worktree 可看进展摘要：分支名、HEAD、最近 10 commits、相对 dev 的 diff stat（基准 `merge-base dev HEAD`）、未提交工作计数（staged / unstaged / untracked）
- [x] AC5: 「编译后端」按钮：只重启该 worktree API 进程链（mount-skills→tsc shared→tsc api→tsx watch，env 子进程注入），next dev 前端进程不动；「重启整个 preview」为独立次级操作（API+Web 全组）；两者均有进行中/成功/失败按钮态 + 日志尾部可见
- [x] AC6: 控制面安全合同：**控制端点（start/restart/compile-backend）只注册在主控制进程**（主 API；worktree preview API 实例经 `WORKTREE_PREVIEW` env 门禁不挂载——preview API 自管自杀悖论 + 单飞锁需单实例）；worktree name→root 仅由服务端从 `git worktree list` 解析（调用方不可传 cwd/命令/env）；spawn 全程无 shell 字符串拼接（args 数组）；操作端点 POST + **allowed-origin 校验**（Origin 头存在时必须命中服务端配置的允许前端 Origin 白名单——主 UI origin + registry 内 webPort origins；**不是** Origin==API Host，前端 :3000/:3100+ 与 API :8787/:8800+ 天生跨源）；每次操作写审计记录（time/action/worktree/result → `.runtime/worktree-preview-ui/audit.log`）；操作物理上碰不到主库进程与主库数据（:8787/:3000 端口断言 + **SQLITE_PATH 包含性断言**：spawn 前验证必须位于目标 worktree `.runtime/worktree-preview/data/` 内且不等于/不落入主库数据路径 + 边界测试）；信任模型 = localhost 单用户 dev（不引入账号体系）
- [x] AC7: 未运行的 worktree 可从 UI 启动 preview（端口走 F024 registry 动态分配），同受 AC6/AC9 约束
- [x] AC8: 每个 running worktree 提供「打开前端」一键入口：**接管式内嵌 iframe**——tab 内容整体切换为细头条+iframe 占满，RuntimeLog 面板自动调高 ≥600px（clamp 内，用户已拖更高则保留），收起恢复列表视图（不开新窗口、不与列表抢空间——小孙验收期两次修正），src=`http://localhost:<webPort>` 端口来自 registry 不可手填
- [x] AC9: 进程所有权：状态文件按**文件系统安全的 worktreeId**（`sanitize(name) + 短哈希`，防 `feat/x` 嵌套路径与碰撞，含专项测试）落 `.runtime/worktree-preview-ui/<worktreeId>.json`，记录 (pid + 进程 CreationDate)；kill 前置预检：**端口 listener pid 必须是记录 pid 的后代**（CIM 进程表 ppid 链解析），且记录 pid 的 OS 实测 CreationDate 与落盘值**精确相等**（同源采集同表示，无容差——±2s 容差方案经德彪 r2 否决，PID 复用窗口可误杀）；整组重启在任何 kill 前完成**双进程全量预检**；任一预检不过 → 拒绝操作并提示（绝不按端口/进程名杀）；主 API 启动时 reconcile（失配只清记录，不杀进程）；UI 路径全程不创建/改写/删除任何 `.env*` 文件（环境仅子进程 env 注入；CLI 路径保留 F024 现状）
- [x] AC10: 同一 worktree 操作单飞：并发第二发返回 409 operation_in_progress（拒绝不排队）

**续作 AC（小孙『只做必须做的』· 本轮交付 worktree 清理 MVP）**
- [x] AC11: Worktree 列表端点每行返回合并状态：相对 dev 的 `ahead`/`behind` commit 数（`git rev-list --left-right --count <baseRef>...HEAD`，**左=behind 右=ahead**）+ `mergedHint`（`git merge-base --is-ancestor HEAD <baseRef>` 纯 exit code；徽标文案**"本地 dev 已包含提交"**非"已合并"，避免 GitHub squash 误读，D14）。**每信号独立 try/catch**，单项失败降级 null **不连累**整张列表（不并进会整体 reject 的 Promise.all）；detached / dev 缺失 / 无共同祖先降级不抛。前端据此渲染**「本地 dev 已包含提交」advisory 徽标**（注：未提交工作计数由 summary 端点提供，见 AC4，不在本行 `MergeStatus`）+ null 容错。**mergedHint 仅 advisory 徽标，绝不作清理按钮硬门**（见 AC12 + D14：merge-gate squash 后 is-ancestor=false，硬门会让做完的 feature 反而清不掉）。测试：ahead/behind 计数 + merged 真实矩阵（F027/F028=已含、F029/F030=未含）+ 单信号失败仍出列表 + detached 降级
- [x] AC12: 「清理 worktree」端点 + UI（延续 AC6 控制面安全合同：**只注册主 API**、POST + allowed-origin 校验、服务端从 `git worktree list` 解析目标【调用方不可传任意 path/name 直删】、审计落 audit.log、单飞锁**复用现有 `inFlight`**）。执行顺序：① 安全门（非主仓 + 目标在 `git worktree list` 内 + 无未提交工作）② 停 preview（**复用 AC9 descendant 预检**，pid 已死则幂等成功，**绝不按端口/名杀**；撞 foreign 则中止+人话提示）**安全门含不可再生原配置保护（德彪 code-r2 P1）**：检测到 `.env*.backup-by-preview`（preview 未恢复的用户原配置，不可再生）→ 拒绝清理，要人工先恢复（git worktree remove 非原子，不让它进删除路径）；普通 `.env.local`（用户已确认要删的 worktree config）不拦。③ **预删可再生构建产物**（planArtifactRemoval **仅 node_modules / .next**；fs.rm force 仅"不存在不报错"非 git --force）④ `git worktree remove`（**无 --force**）**删除整个 worktree 含其自造运行数据**（.runtime 隔离 SQLite / .agents/acceptance uploads 等——小孙 2026-06-14「worktree 造的数据可删」；实测 remove 删 ignored 数据、仅对 untracked 非 ignored 的用户未保存工作才拒→回传人话错误）⑤ `git branch -d`（git 内建合并保护，未合并/失败→保留分支标 residue，**非失败链**）⑥ releasePorts + 清状态文件 → 即时从列表消失。返回 `{steps:[{name,ok,message}]}`，git/rm 输出纳入。**失败两态语义（git worktree remove 非原子，德彪 code-r3 P2）**：remove 失败后复查注册——**worktree 仍注册**→真失败可**重点击重试**；**已注销但删除中途失败**→继续收口（branch/端口/状态，防孤儿）+ 报"残留目录需人工删"，整体 ok:false。**无事务日志/tombstone**。**清理按钮可用性（德彪愿景 review P0）**：按钮对**任何非主仓 worktree** 出现，**绝不以 mergedHint 硬门**（merge-gate 走 squash，feature 做完 squash 合 dev 后 is-ancestor=false → mergedHint=false，硬门会让做完的 feature 反而清不掉——恰好击中小孙核心场景）；安全由后端安全门 + git branch -d 内建保护 + 两步确认兜底；主仓 **never cleanable**。测试：顺序 + planArtifactRemoval 只预删 node_modules/.next + backup-by-preview 拒 + .env.local 不拦 + **真 git 集成（清成功消失 / untracked 用户文件拒保留 / 完整 runWorktreeCleanup 遇 backup 拒保留）** + foreign 中止 + branch -d 未合并保留 + 清完消失 + **mergedHint=false 行仍有清理按钮 + 主仓无清理按钮 + releasePorts 两 key 独立 best-effort**
- ⏸️ **AC13【本轮范围外·已转出 OQ8·待小孙拍 — 不计入本轮 Completion】**: 脱管 preview「强制接管」takeover（按端口停 foreign listener）—— 安全方案未决（`CommandLine`≠cwd 不能证明归属），待小孙拍板纳入后另走安全 Design Gate（OQ8）。C 区清理撞 foreign 仅中止+提示，**不依赖**此 AC。**德彪愿景 review：Completion 前须把此项明确转出，不留 unchecked AC——已转出。**

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
| D6 | 进程模型 | 复用 supervisor 进程 / 编排器直管两子进程 | **主 API 编排器分别 spawn dev:api 与 dev:web（detached + 日志落盘 + 状态文件记 pid+CreationDate）** | 「编译后端」需要单杀 API 子进程；supervisor 整组模型做不到靶向重启（德彪 r1 P2-5/P2-6 连锁结论） |
| D7 | 杀进程依据 | 端口 listener / pid+CreationDate 所有权 | **r2 升级**：kill 前置预检 = 记录 pid 的 CreationDate 同源采集**精确相等**（无容差）+ 端口 listener 必须是记录 pid 的**后代**（CIM ppid 链）；整组重启先全量预检后才 kill；任一不过 → 拒绝+提示 | 德彪 r1 P1-3 + r2 P1-4：端口杀误伤、±2s 容差在 PID 复用窗口仍可误杀，后代关系才证明 listener 归属 |
| D8 | secrets 边界 | 模糊"类" / 精确 denylist | **精确 denylist**：目录 `node_modules` `.git` `.next` `.npm-cache` `.worktrees` `.runtime` `.agents` `data` `.codex` `.gemini` `.obsidian`；文件 `.env*` `auth.json` `*.pem` `*.key` `*.p12` `*.pfx` `id_rsa*` `*.token` `.npmrc`；**隐藏**（list 不出现 + content 404） | 德彪 r1 P2-7："auth/token 类"不可测试；隐藏优于置灰（不暴露存在性） |
| D9 | UI 路径 dotenv | 复用 F024 prepareDotenv / 零写入 | **UI 路径零 `.env*` 写入**，环境全部子进程 env 注入（Next.js process.env 优先于 .env 文件）；CLI 路径保留 F024 现状 | 德彪 r1 P1-4：运行时自动改 `.env*` 踩铁律 3；CLI 是人工操作不受影响 |
| D10 | 控制面信任模型 | 引入 auth / localhost 单用户 + allowed-origin + 审计 | **沿用 repo localhost 单用户模型**，加 POST + **allowed-origin 白名单校验**（Origin 存在时须命中主 UI origin / registry webPort origins；Origin==API Host 方案被 r2 否决——前端与 API 天生跨源）+ 审计日志，不建账号体系 | 德彪 r1 P1-2 要求安全合同 + r2 P1-1 修正校验对象；r2 明判认可不建账号体系 |
| D11 | Design Gate 状态 | 已过 / 条件放行 | **条件放行**：小孙草图放行 + 点名德彪愿景审；r1 9 findings 已修，r2 6 P1 修订中（r3 复审 GO 才算过） | 德彪 r1 P2-9：小孙明确把德彪愿景审纳入门 |
| D12 | 控制面进程拓扑 | 每个 API 实例都挂控制路由 / 仅主控制进程 | **控制端点只注册在主 API**（`WORKTREE_PREVIEW` env 注册门禁）；preview API 实例只提供只读列表；preview UI 操作按钮禁用 + 提示去主 UI | 德彪 r2 P1-2：preview API 自管会先杀自身进程树（自杀悖论），多实例也使内存单飞锁失效 |
| D13 | 状态/日志文件命名 | 直接用 worktree name / 安全 slug | **worktreeId = sanitize(name) + sha1 短哈希**，文件名仅由 worktreeId 构成，含 `/` 与编码碰撞专项测试 | 德彪 r2 P1-3：`feat/F024` 类名直接拼文件名产生嵌套路径 |
| D14 | "已合并"提示 | 严格判定 / best-effort 提示 | **`git merge-base --is-ancestor HEAD <baseRef>`**（HEAD 在前 = HEAD 已被 baseRef 包含；纯 exit code）。本地 squash 流程成立（实测 F027/F028=已含、F029/F030=未含）；GitHub squash 图无法区分 → 降级不显示。**仅提示不作硬门**，徽标"本地 dev 已包含提交"非"已合并" | merged 单信号不足判可清且 squash 不可靠；只作提示，真正守门交给 `git worktree remove` / `branch -d` 的内建拒绝 |
| D15 | 清理时数据安全边界 | 保护所有数据 / worktree 自造数据可删 + 不可再生原配置守 | **小孙 2026-06-14『清理 worktree 上的数据是可以删的，只要是 worktree 造出来的』**：worktree 的 preview 隔离 SQLite / uploads / runtime-events / node_modules / .next 等是 **ephemeral dev 数据，非主仓神圣数据，随 worktree 删**。实现：① **预删仅 node_modules/.next**（可再生构建产物，避 Windows file-busy）② 其余 worktree 自造数据（.runtime/.agents 等 ignored）由 `git worktree remove`（无 --force）删——**实测**：remove 删 ignored 文件，仅对 untracked **非 ignored** 的"用户未保存工作"才拒（EXIT 128）③ **git worktree remove 非原子**（德彪 code-r2 P1：中途失败仍注销留半态）→ 对**不可再生**的 `.env*.backup-by-preview`（preview 未恢复的用户原配置）**安全门提前拒绝**，绝不进非原子删除路径；普通 `.env.local`（用户已二次确认要删的 worktree config）不拦 ④ 安全门（git status 空）+ git 的 untracked 拒绝＝双保险挡未保存工作。**Iron Law 1 仍守**：清理只在 worktree 路径内操作，**绝不触碰主仓**（主仓 .runtime/data 是另一路径）。真 git 集成测试锁死 | 小孙更正"禁碰数据"过度保守 + 德彪 code-r2 揪出 remove 非原子→不可再生原配置须安全门守；企业三分类装置仍收敛删除 |
| D16 | 停 preview | 新建编排能力 / 复用现有预检 kill | **复用 AC9/D7 现有 descendant 预检 kill 路径**（端口 listener 必须是记录 pid 后代 + CreationDate 精确相等，**绝不按端口/名杀**）；pid 已死则幂等成功；撞 foreign 中止+提示不自动 kill | 复用既有 guard，不为清理重造 stop 三态事务 |
| D17 | 删分支 | OID CAS plumbing / branch -d | **`git branch -d`**（git 内建合并/工作树保护，未合并就拒）；失败/未合并→保留分支标 residue 可重试，非失败链 | 安全默认=证不了已合并就保留分支；branch -d 已是 git 内建保护，无需自建 CAS |
| ~~D18-D23~~ | ~~resourceId/tombstone/三分类/managed-root/双 registry/OID CAS~~ | **收敛删除** | **小孙 2026-06-13『只做必须做的』收敛删除**：企业级删除装置（哈希资源身份 D22、崩溃恢复事务 D21、managed-root 逐步重验 D18、双 key registry 全删 D20、分支 OID CAS、orchestrator.stop 三态 D19）对"删开发态 worktree"过度。德彪 r1→r3 提出的这些点记录在 Timeline；未来若清理出现真实 crash/竞态数据损坏再立 TD 加固 | 反过度工程：删 worktree 小工具不背企业删除系统 |

## Open Questions

1. ~~优先级~~ → D1
2. ~~"手动编译"语义~~ → D2（r1 改判：API 链靶向重启）
3. ~~项目目录的根~~ → D4
4. ~~只读够用否~~ → D3（德彪判定不算缩水）
5. ~~secrets 边界~~ → D8（精确 denylist）
6. ~~并发/进程归属/排除清单~~ → D6/D7/D8/AC9/AC10（德彪 r1 后收口）
7. ~~小孙"加几块内容"仅列两块~~ → 该 OQ 原指**主线两个 tab**（项目目录+Worktree，2026-06-11 立），非续作 C/D 区；但其 scope 纪律（小孙点名 N 块，别外推未点名的）正适用续作 → 见 OQ8
8. **【续作 · 待小孙确认】D 区 takeover（AC13 / D16）愿景归属 + 安全方案**：小孙续作原话只提 worktree 清理（C 区），脱管 takeover 是黄仁勋从实战死锁外推。**takeover 安全方案未决**（CommandLine≠cwd，德彪 r2）。本轮 C 区交付（含 foreign 人话提示），takeover **待小孙晨会拍板**：(a) 纳入 F028 → 另走安全 Design Gate / (b) 另立 feature。**takeover 确认前不实现；但不阻断本轮清理 MVP（AC11-12）合并**——本轮交付不含 takeover。问题陈述 + 候选方案保留有价值（内审 P1-vision + 德彪 r1/r2）
9. **【续作 · 待小孙拍】「做完自动消失」零点击 vs 一键（德彪愿景 review P0-a）**：小孙原话「Feature 做完了 他会自动在我的 worktree 列表消失吗」。本轮交付 = **一键清理 + 清完即时消失（准自动）**，且 lifecycle「做完→消失」已由 **merge-gate 流程**（feature merge 后由 agent 按 SOP 清 worktree——注：merge-gate 是 agent SOP 非系统 daemon，不混称「自动」）服务，AC12 再加自助一键（含 squash 合并后仍可清，本轮修）。**德彪愿景 review r2 已接受此框定**（一键准自动 + merge-gate 必做清理足以作为本轮交付，零点击后台 hook=可选增强不阻断）；桂芬跨 agent 愿景验同判「愿景对齐」。留小孙一句话拍：(a) 接受一键准自动 = F028 续作收尾（默认）/ (b) 要零点击 auto-cleanup-on-merge（hook merge-gate）= 另开小增强。**本轮按 (a) documented scope 交付 working+merged；(b) 是可选 follow-up，不阻断。**

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-06-11 | Kickoff（小孙口述 RuntimeLog 未来拓展两项需求） |
| 2026-06-11 | 讨论收口 + Design Gate 条件放行（小孙 /goal 放权全流程推进，点名德彪审文档愿景对齐） |
| 2026-06-11 | 德彪 codex r1 愿景审 **NEEDS-WORK**（4 P1 + 5 P2 + 愿景对齐表 3 ❌）；9 findings 全接，AC 重构为 10 条，Design Decisions 扩为 D1-D11 |
| 2026-06-11 | 德彪 codex r2（文档复审+plan 初审）双 **NEEDS-WORK** 6 P1；全接：allowed-origin 修正、控制面单实例（D12）、worktreeId slug（D13）、后代预检+精确 CreationDate（D7 升级）、SQLITE_PATH 包含断言、readContainedFile maxBytes 原语扩展；r2 明判认可 D10 不建账号体系 |
| 2026-06-11 | 德彪 codex r3：**文档 GO**；plan NEEDS-WORK（4 P1 残留/深挖 + 2 P2）并依家规 §17 触发 **TAKEOVER**（黄仁勋连续两轮"全修"复验有残留）。黄仁勋降级信息提供者交四件套，**桂芬（gemini CLI）接管 plan 修订**：worktreeId 日志命名统一、resolveControlPlaneOrigins 独立白名单解析器、SQLITE_PATH mkdir 时序+祖先 junction 检查、假超时残留清除、slug ≤40 长度上限、CreationDate 术语统一。待德彪 r4 复审（接管者不得自审） |
| 2026-06-11 | 德彪 r4（配额 4:11 重置后重派）NEEDS-WORK 3P1+2P2+doc patch 指令 → 桂芬 r5 续修：start 外来端口预检、主 UI origin 固定 :3000 三形态测试、SQLite 先查祖先后建目录（junction 场景断言零创建）、slug 前缀 ≤31、Get-CimInstance 术语统一+删 UI 渲染检查；D6/D7 doc patch（pid+CreationDate）。双侧残留 grep=0（桂芬自查+黄仁勋独立复核）。Task 0（buildPreviewEnv 迁 shared，r2/r3 零质疑纯重构）已在配额窗口期完成于 worktree `16b1438` |
| 2026-06-11 | 德彪 r6 NEEDS-WORK 2P1+1P2（SQLITE realpath 首启 ENOENT / Windows pnpm .cmd spawn 适配 / NTFS ADS 冒号流）→ 桂芬 r7 修（plan v5 `e925112`）→ 德彪 r8 **GO，findings 清零（轨迹 9→6→5→3→0），Design Gate 关闭，TAKEOVER 任务结束**。黄仁勋恢复 author，status → in-progress，开 TDD 实施 |
| 2026-06-12 | 小孙 :3101 真机验收反馈修正 AC8：「我不想要打开前端的时候 打开一个新的网页 我想要嵌在下面」→ 打开前端改为面板内嵌 iframe，window.open 移除；TDD 红→绿，前端全套 589/589 |
| 2026-06-12 | 小孙验收反馈 ×2：「前端画面有问题 我只能看到一点点！！！」——iframe 挤在列表/摘要下方+面板默认 320px 高只露一条缝。修正为**接管式视图**（嵌入时 tab 整体让位给 iframe，细头条+收起钮）+ 嵌入时面板自动调高 ≥600px；TDD 红→绿 |
| 2026-06-13 | 德彪 codex 代码 review r1 **NEEDS-WORK** 3P1+4P2（耗 21.7 万 token）：claim worker shell:true 注入面 / denylist Windows 大小写绕过（守护修复余洞）/ killTree 吞错+缺 plan 要求的杀后端口复探 / spawn 后 CIM 采集失败孤儿 / root 删除竞态 500 / ownership 未逐 alive 端口校验 / 打开前端漏 control 门禁（preview 自嵌递归）。七条全验真零 pushback，TDD 红（13 例）→绿全修（commit 28d269b）；node 直跑 tsx cli 真机验证元字符名 `F028&calc^|evil` 纯字符串往返。披露裁断：guardian 修复判不完备（大小写）、taskkill 连坐记运维 P3、flaky/registry 旧条目不阻塞、AC8 两轮修正确认无残留 |
| 2026-06-13 | 德彪 code r2 **NEEDS-WORK**：r1 七条全 ✅ 确认修对，新挖 1 P2「NTFS 8.3 短名/别名绕过 denylist」（词法段查不住 realpath 规范化后的 NODE_M~1→node_modules，判本轮必修不准记 TD）+ P3（plan npx 残留）。修：tree-list/tree-content realpath 后对真实相对路径重跑 denylist（list/content 对称），junction 同构稳定复现不赌卷 8dot3name；plan worker 合同同步 node 直跑（commit 057df85）。后端全量 3122 pass |
| 2026-06-13 | 德彪 code r3 **GO（可进 merge-gate）**：P2 两端对称确认，目录/文件 8.3 短名+junction+hardlink 全拦，正常路径无误杀，P3 同步到位。已知非阻断缺口：文件级别名指向 .env 无独立测试（Windows 文件 symlink 需管理员权限/8.3 赌卷配置，强造即 flaky，实现逻辑已覆盖）。代码 review 链闭环 r1→r2→r3 |
| 2026-06-13 | merge-gate：AC1-AC10 全打勾，21 commits squash 合入 dev（ff-only，rebase onto aacea1b 零冲突）|
| 2026-06-13 | Completion：桂芬（gemini）跨 agent 愿景验证 **PASS**（证物对照 10/10 ✅，逐字核小孙原话含两轮 AC8 修正）；status→done，ROADMAP 移已完成表。Closes F028（主线）|
| 2026-06-13 | **续作重开**：小孙实战触发（脱管 preview descendant 死锁）+ 点名"worktree 清理纳入 F028"。黄仁勋先排障清野进程（端口 free），再落 AC11-14 + D14-17（worktree 清理 C 区 + 脱管恢复 D 区），status→in-progress |
| 2026-06-13 | 续作 doc 自检：黄仁勋启 Workflow 多维 adversarial 内审（32 agent / 180 万 token / 5 lens：愿景·IronLaw·git·实现贴合·完整性，26 finding 经独立 verify 校准）。综合修订：**D 区降级"提议待小孙确认"**（scope 纪律 P1-vision）；C 区强化——删除根 containment 原语 D18、orchestrator.stop D19、清理收口 deleteState+registry D20、失败语义 D21、ahead/behind 命令契约 + per-signal 降级、origin 软门、单飞锁共享、审计字段级。已合并判定经真实 worktree 矩阵实测精确化（is-ancestor≡ahead==0，标 origin 前提）|
| 2026-06-13 | 德彪 codex 权威 doc 愿景审 r1 **NEEDS-WORK（7 P1 + 4 P2）**：①清理顺序与 git 行为相反（rm 须在 remove 前，D23）②D15 查错目录（真数据在 `.agents/acceptance/uploads` 非 .runtime，buildPreviewEnv:46 实证）③remove 后 inventory 消失无法重试（cleanup 事务+tombstone D21）④basename 删错 worktree（opaque ID D22）⑤列表级 eligibility 缺（AC11 共享谓词）⑥branch 删除竞态（OID CAS + 两种成功语义）⑦registry 严格 release（D20）；P2：CommandLine≠cwd 接管护栏不可实现（D16 安全方案未决）/ D18 gitdir 身份 vs 固定 .worktrees / stop 三态 / origin 软门语义。**D 区表态：认可降级，不认可"设计就绪"，takeover 另走安全 Design Gate**。11 findings 全 VERIFY 通过全盘接受，doc 第二轮综合修订（D14-D23 + AC11/12/13/14 重写），待德彪 r2 复审 |
| 2026-06-13 | 德彪 codex doc 愿景审 r2 **NEEDS-WORK**：r1 11 findings 5 修对（D15 路径/列表 eligibility/takeover 降级/stop 三态/origin 语义）+ 6 残留 + 9 新 finding（is-ancestor 参数写反 D14 / opaque ID 混三身份须拆 resourceId D22 / tombstone 缺 crash 恢复合同 D21 / 数据白名单卡含 report 的 feature 须三分类 D15 / D18 须 managed root + 逐步重验 / branch -d 内建保护 vs CAS plumbing 冲突 D17 / registry 双 key 全删 D20 / D 区 scope 矛盾拆 AC13-OQ8 / 计数 P3）。8 条真 finding 全 VERIFY 接受（P3 计数为误读主线注释已澄清），第三轮修订（D14 方向纠正 + D15 三分类 + D17 branch -d + D18 managed root + D20 双 key + D21 tombstone 完整合同 + D22 resourceId 拆分 + AC12/14 重写 + What 顺序 + AC13/OQ8 拆分），待德彪 r3 复审 |
| 2026-06-13 | 德彪 codex doc 愿景审 r3 **NEEDS-WORK**（4 P1 残留：tombstone crash 状态机 / branch -d vs OID CAS / 双 registry 实例发现 / resourceId 身份合同）。**但小孙同日拍板「继续吧不需要过度设计了 只做必须做的」+「你做你该做的事吧」**——r3 审的全是企业级删除装置，与小孙最小化诉求冲突。**SCOPE 收敛 MVP**：砍掉 D18-D23（resourceId 哈希/tombstone 事务/数据三分类/managed-root 重验/双 registry 全删/OID CAS/stop 三态），保留 D14-D17（merged 提示 best-effort / 最小白名单+git 守门 / 复用 AC9 预检 kill / branch -d）；AC11-14→AC11-13（清理 MVP）。德彪 r3 findings 不追（审的是被砍设计），愿景信号小孙已直接给。德彪改留**代码 review**（高价值点），不再多轮审 doc 愿景 |
| 2026-06-14 | 续作 worktree 清理 MVP（AC11+AC12）**实现 + 德彪 codex 代码 review 8 轮闭环 GO**：r1-r6 逐轮真洞（数据安全/统一锁/UI 健壮/非原子 remove 守不可再生原配置/安全门 fail-closed/非原子两态收口/注释真相源/前端始终 refetch/plan 真相源同步/releasePorts 两 key 独立 best-effort），P1 自 r3 清零；r7 抓黄仁勋 merge-gate 前自审的 2 个过度改（POSIX 大小写过度匹配 + detached 端口 churn）→撤回；r8 **GO**（detached registry-key 一致性记独立 TD，CLI/inventory 既有契约，非 F028 引入）。零上下文 acceptance-guardian **PASS**（AC11/12 对码+测；backend 0 fail / frontend 20/20 / typecheck 0；`.agents/acceptance/F028/guardian-r8go/`）。 |
| 2026-06-14 | **小孙点名愿景 review**（临睡「这个 feature 文档就要找德彪讨论是否符合我的愿景」+ 授权 autonomous 推到 done）。德彪愿景 r1 抓到 **code review 漏的真 P0**：清理按钮硬门 `mergedHint===true`，但 merge-gate 走 squash → feature 做完后 is-ancestor=false → 按钮**恰好在要清理时消失**（测试/guardian 用 mergedHint=true fixture 漏掉）。**修**：按钮改仅 `!isMain`（mergedHint 降 advisory 徽标）+ 测试（squash 后仍可清 / 主仓 never cleanable）；AC13 转出 OQ8；doc 真相源全扫修正；OQ9 记零点击 vs 一键留小孙拍。桂芬跨 agent 愿景验 + 德彪愿景 r2 双判**功能愿景对齐 GO**（一键准自动 + merge-gate lifecycle 足够，零点击=可选）。frontend 21/21 / backend 98/98 / typecheck 0 / check-docs 过。**清理按钮浏览器真机=control:true 仅主 UI（preview 实例 D12 control:false），主 UI 跑 dev 代码→真机必然在 merge 后**：合并后由黄仁勋（牺牲性 worktree）或小孙做 live 验收 spot-check（破坏性按钮）。**剩：merge + push + 合并后真机 + Completion 收尾**；AC13（D 区 takeover）+ OQ9 零点击 待小孙拍 |
| 2026-06-14 | 德彪愿景 r3 **GO 可 merge**（doc 真相源通过 + 真机 control:true circularity 论证成立，组件+真 git 集成测试足以放行）。**merge-gate**：rebase onto dev（F030 中途落，仅 ROADMAP 冲突已解）→ squash 14 commit 成 1 → **ff-only merge dev `d528d40` + push origin/dev**。feat-lifecycle **Completion**：愿景对照（德彪愿景 3 轮 + 桂芬跨 agent 双 GO）+ AC11/12 全勾 + status→done。**清理按钮 live spot-click 留小孙首用即验收**（control:true 仅主 UI 连真库，Iron Law 1 不自动起；全层已测：21 组件 + 3 真 git 集成 + 路由）。AC13 脱管 takeover（OQ8）+ OQ9 零点击 auto-cleanup 待小孙拍 → 如要另开 follow-up |

## Links

- Discussion: 本文件 Why（小孙原话）+ Open Questions 章节
- Plan: `docs/plans/F028-workspace-explorer-tabs-plan.md`
- Review: 德彪 r1 `.runtime/reviews/F028-doc-review-codex-r1.md`（scratch，不入库）
- Related: F024, F027

## Evolution

- **Evolved from**: F027（RuntimeLog 一级 tab「未来」扩展位的第一次兑现）
- **Blocks**: 无
- **Related**: F024（worktree preview 基础设施被 Tab B 包装为 UI 能力）
