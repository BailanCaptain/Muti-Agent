# B026 — 发消息后 ~14 秒无可见进度死区（轮反馈死区）

- **报告人**: 小孙（2026-07-10，F043 活体验收现场）
- **拍板**: 小孙定性为 BUG（非 feature），F043 合并后立即修
- **Status**: open
- **Owner**: 黄仁勋

## Bug 现象

小孙原话：「我发了信息在房间里 过了好一会儿 agent 消息才出来 而且我发完输出框也不会立马变成暂停按钮 仿佛后台去拉 CLI 这个过程特别长」。

发消息后到第一个字出现之间（实测 ~14 秒），界面没有任何可见的进行中反馈——体感"没发出去/卡死了"。

## 实测时序（2026-07-10 计时探针，worktree preview，claude opus ~49k 上下文短消息轮）

| 时刻 | 事件 |
|---|---|
| +0.01s | 用户消息 message.created 上屏 |
| +0.04s | assistant 占位 message.created + status「正在运行」 |
| **+0.34s** | thread_snapshot_delta running=true 推达发送者 socket（暂停按钮的数据已到） |
| **+14.03s** | 第一个流式 delta（气泡才开始出字）← **死区 = 0.34s ~ 14.03s ≈ 13.7 秒** |
| +18.13s | 收尾（message.updated 终稿 + token 胶囊） |

死区构成：CLI 进程冷启动 + MCP 挂载 + 模型在大上下文上的首 token 时延。服务端推送全部即时（<0.5s），缺的是**前端在首 delta 前的进行中呈现**。

## 复现步骤

1. 打开任一会话（web :3000 或 preview 端口）。
2. @任一 agent 发一条短消息。
3. 观察发出后 ~14 秒窗口：气泡区无出字、无骨架/打字动画；（小孙报告）输出框也不立即切换为暂停按钮。

## 根因初判

1. **占位气泡不可见**：assistant 占位 message.created 内容为空串，空内容卡片在首 delta 前呈现近似不可见——用户看不到"已经在跑"。
2. **暂停按钮**：composer 的 running 态数据（thread_snapshot_delta）实测 +0.34s 已到发送者 socket；若小孙复现"按钮长时间不变"，需真浏览器复核 running=true → 按钮渲染链是否有前端断点（修复时第一步先验证此点，勿直接假设数据未到）。
3. 归因排除：F043 diff 全在轮收尾侧（settlement/message.updated/seal 谓词），发送→spawn 路径零改动——本 bug 为存量体验问题，preview 冷环境放大感知。

## 修复方向（实现时定稿）

- 占位气泡骨架/打字动画：running=true 即显（关键交付）
- spawn 阶段化 status（拉起 CLI → 模型思考中），替代 14 秒静默
- 真浏览器复核暂停按钮链路（running=true → composer 渲染），有断点一并修

## 验证方式

- 计时探针复跑：发消息后 ≤1s 内页面出现可见进行中反馈（骨架/动画/按钮切换），不再有 >2s 的无反馈窗口
- 小孙原复现路径亲测：发消息体感"立即有反应"
- 回归：正常流式/收尾胶囊（F043 AC6/AC8）不受影响

## 关联

- 发现现场：F043 活体验收（docs/features/F043-token-accounting-fix.md Timeline 2026-07-10）
- 实测数据存档：session 记忆 bug_turn_feedback_dead_zone
