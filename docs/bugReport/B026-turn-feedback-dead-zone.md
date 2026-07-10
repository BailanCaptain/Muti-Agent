# B026 — 发消息后 ~14 秒无可见进度死区（轮反馈死区）

- **报告人**: 小孙（2026-07-10，F043 活体验收现场）
- **拍板**: 小孙定性为 BUG（非 feature），F043 合并后立即修
- **Status**: closed — 德彪 r2 GO + 小孙放行合入（2026-07-11「你改了前端体验我没意见」「先把这个往下推进吧 按照流程」；推理块显示不受影响、Stop 按钮取舍、新会话首轮 23s 为 CLI session 初始化结构性耗时三点均已当面呈报）
- **Owner**: 黄仁勋
- **分支**: fix/B026-turn-feedback-dead-zone（commits `7517f47` + `2118978` + `30468c5`）
- **Review**: guardian Bug Mode PASS（零上下文，亲跑探针 87ms 点亮/840 全绿）→ 德彪 r1 NO-GO（2P2+1P3：同房 resync 误清 marker / spawn 前失败无终态收口 / raw thinking 判空）→ 三修 `30468c5` → **r2 GO（零残留）**；审档 .runtime/reviews/B026-codex-r{1,2}-raw.txt

## Bug 现象

小孙原话：「我发了信息在房间里 过了好一会儿 agent 消息才出来 而且我发完输出框也不会立马变成暂停按钮 仿佛后台去拉 CLI 这个过程特别长」。

发消息后到第一个字出现之间（冷 spawn 实测 23~33s，warm/resume 轮 ~10s），界面没有任何可见的进行中反馈——体感"没发出去/卡死了"。

## 实测时序（2026-07-11 修复前，worktree preview :3104，真浏览器探针）

### 冷 spawn 轮（preview 重启后首轮，探针 mrf8lsm2）

| 时刻 | 事件 |
|---|---|
| +0.08s | 用户消息上屏 + assistant 占位壳（空 body 卡片） |
| **+23.4s** | **Stop 按钮 + 「智能体正在回复中」banner 首现**（running=true 首次到 DOM） |
| +33.3s | 首个流式 delta（气泡才开始出字） |
| 全程 | 气泡内进行中指示：**无** |

> **修正 07-10 初报**：初版 report 写"running=true 数据 +0.34s 已到发送者 socket"——该记录有误。F043 现场探针只证明了 thread_snapshot_delta **帧**在 +0.34s 到达，未核帧内 running 值；B026 复测（DOM 级）证明 running=true 直到 CLI spawn 完成才出现（冷轮 +23.4s / resume 轮 +0.3~0.6s）。**小孙"按钮不立马变"的报告是数据事实，不是感知偏差。**

## 根因分析

1. **主根因 · 占位气泡是壳卡片**：轮开始时 assistant 占位以 `content=""`、`messageType="final"` 落库广播（message-service.ts `appendAssistantMessage(thread.id, "", "", "final", ...)`）。前端 MessageBubble：content 空 → BlockRenderer 空渲染；`isStreaming`（=messageType==="progress"）false → 无「输出中」徽章；tokens=0 → 无 meta。**首 delta 前气泡 = 头像+名字+时间+空白 body，零动效**。
2. **次根因 · running 语义 = CLI spawn 完成**：`providers[].running` 由后端 `invocations.keys()` 算出，thread 进入该集合的时机是 `attachRun`（message-service.ts:2065，CLI 进程 spawn 返回 handle 后）。轮开始（:2057）emit 的 snapshot delta 里 running=false。**Stop 按钮 / 「正在回复中」banner / 一切绑 running 的反馈都盖不住 spawn 期死区**（冷轮 ~23s）。
3. **status 行静态**：死区期间 composer 状态行文案不变，无阶段感。
4. 归因排除：非 F043 引入（F043 diff 全在轮收尾侧）；存量体验问题，preview 冷环境放大感知。

## 修复方案（已实现，纯前端）

**核心：`awaitingFirstOutput` 生命周期（thread-store）** —— 触发源改用消息事件本身，不绑 running：

- **mark**：page.tsx 收到 `message.created` 且 role=assistant、content=""、属当前会话 → 标记（占位事件 +0.04s 到达，骨架即刻点亮）
- **渲染**：MessageBubble 命中标记且载荷全空（content/thinking/toolEvents/contentBlocks）→ body 渲染 `SkeletonLines`（复用 F039 组件）+ 阶段文案
- **阶段文案**（借 running=attachRun 的真实信号，非假定时器）：spawn 前「正在启动智能体…」→ spawn 后首 token 前「正在思考…」——直接回应"仿佛后台拉 CLI 特别长"，用户能看到阶段推进
- **清除收口**：首个 `assistant_delta` / `message.updated` 终稿 / **running 下降沿**（prev true → next false = 轮真的结束，异常轮兜底）/ **真切房**（德彪 r1 P2-1：同房 resync——重连/catch-up——保留 marker，否则死区中骨架被洗回壳）。下降沿判定是 probe4 诊断桩抓到的修正：轮开始的 delta 里 running 本来就是 false，"只看 false 就清"会让骨架只活 ~0.3s（回归测试锁死）
- **spawn 前失败终态收口**（德彪 r1 P2-2）：后端 catch 路径 overwriteMessage 后广播 `message.updated`——spawn 失败时 running 永无下降沿、snapshot delta 只 append 不 replace，唯有本事件能按消息 ID 精确清 marker；顺带修掉"错误终稿要刷新才可见"
- **thinking 判空用可见性**（德彪 r1 P3）：raw thinking 非空但用户看不到（关心里话/纯噪声被 cleanThinking 滤空）时骨架不让位
- **Stop 按钮不动（有意取舍，德彪 r1 认可）**：按钮语义 = 可停性（spawn 完成前 run handle 不存在，cancel 无效）；提早显示会制造"点了不停"的新 bug。死区反馈职责由气泡骨架承担。
- **已知边界**：刷新页面后 awaiting 集清空——死区中的轮骨架不恢复（running 到位后有 Stop 按钮/banner 兜底），主路径（发消息不刷新）100% 覆盖。

## 验证方式（修复后实测，2026-07-11）

### 探针复跑（mrf9syst，preview 重启 + resume 轮）

| 时刻 | 事件 |
|---|---|
| +0.12s | 用户消息上屏 |
| **+0.29s** | **骨架 + 「正在启动智能体…」出现** ✅（验收标准 ≤1s） |
| +0.63s | running=true → Stop 按钮 + banner + 文案切「正在思考…」 |
| +9.8s | 首 delta；**骨架同刻退场**（skeletonGone === firstDelta，全程覆盖无早退） |

- 截图：`.agents/acceptance/B026/probes/shots/t+1s-dead-zone.png`（骨架+思考中+Stop 按钮+running 徽章同屏，随 worktree 生命周期保留）
- 探针脚本：`.agents/acceptance/B026/probes/dead-zone-probe.mjs`（可复跑）
- 单测：`thread-store.awaiting.test.ts` 7 条（生命周期+下降沿回归）+ `message-bubble.test.tsx` B026 块 7 条（骨架/阶段文案/六种不渲染场景）；FAIL→PASS 记录在 TDD commit 序列
- 全量回归：vitest 838 passed / typecheck 0 / pre-commit hook（typecheck→check-docs→lint-staged→pnpm test）两轮全绿
- F043 AC6/AC8 回归：修复后截图中上一轮 token 胶囊（54.6k tokens/缓存 53%）正常渲染；全量测试含 F043 测试套件全绿
- 小孙验收：方案与取舍当面过（推理块不受影响 / Stop 按钮维持可停性语义 / 新会话首轮 23s = CLI session 初始化，进程池经评估不立、留观察），拍板按流程合入
- 衍生观察项（未立项）：新会话首轮分解打点（进程创建/skills 挂载/MCP 连接/首 token 各占比）——若日后要优化首轮时延，先打点再拍方向（skills manifest 缓存可能是最便宜的刀）

## 关联

- 发现现场：F043 活体验收（docs/features/F043-token-accounting-fix.md Timeline 2026-07-10）
- 实测数据存档：session 记忆 bug_turn_feedback_dead_zone；诊断胶囊 `.runtime/reviews/B026-diagnosis-capsule.md`（worktree 本地）
- 环境事实（排查中沉淀）：本机 tsx watch / next dev 文件 watch 均不重载，浏览器验证必须重启 preview；后台服务命令禁接 `| head`（EPIPE 杀进程）
