# B025 · trigger_mention 目标契约歧义 → 派发静默死亡 + 假成功

**发现**: 2026-07-04，F040 AC9 真机验收中（小孙手机让仁勋"叫德彪"，三连失败）
**状态**: fixed（修复随 F040 worktree 合入 dev）
**严重度**: P1 —— agent 间程序化派发链路可静默全灭，且调用方拿到假成功

## 症状

小孙（手机/网页两路复现）让房间里的仁勋叫范德彪：

1. 仁勋调 MCP `trigger_mention`，`targetAgentId` 传了 `"codex"`（provider id）
2. 服务端不校验，拼出 `[Call: @codex 请注意]` 落库广播
3. A2A 网关按 `PROVIDER_ALIASES`（花名表）解析 `@codex` 失败 → **静默丢弃，零派发**（a2a_calls 无 codex 行，codex 线程零新消息）
4. 但 `trigger_mention` 工具早已返回 `ok:true` → 仁勋向小孙汇报"搞定 ✓ —— 德彪已 @mention"

真机三连击实锤（06:29 / 06:31 / 06:34），haiku 和 **opus-4-8 都踩**——不是弱模型问题，是契约问题。

## 根因（三层叠加）

1. **参数契约歧义**：MCP schema 参数名 `targetAgentId` 暗示传 provider id，描述却写"目标 agent 别名"（`mcp/server.ts:445`）——模型照参数名传 `codex` 完全合理
2. **服务端零校验/零归一化**：`callbacks.ts` trigger-mention 路由与 `buildMcpDispatchPayload`（`server.ts:95`）对目标字符串原样拼接；连测试都把 `"@范德彪"`（带 @）原样透传当正例——那会拼出 `[Call: @@范德彪 ...]` 双 @，同样死
3. **下游静默失败**：A2A 网关对解析不出的 `[Call: @X]` 不抛错不回报，工具返回 ok:true → 调用 agent 拿假成功，无自纠机会（F026 P0 Task4 铺好的 ok:false 冒泡通道从未被这条路径触发）

**实际契约（修复前）**：只有传裸花名 `范德彪` 才活；`codex` / `@范德彪` / `德彪` 全部静默死。

## 修复（fail-closed + 自纠闭环）

`packages/api/src/routes/callbacks.ts` 新增 `resolveMentionTarget()`，路由层统一归一化：

- 剥 `@` 前缀（含多重）
- 花名精确命中（`PROVIDER_ALIASES` 值）→ 通过
- provider id（大小写不敏感 `codex/claude/gemini`）→ 映射花名
- 未知目标 → HTTP 200 + `{ok:false, error:<可用名单>}` + status 广播（走 F026 既有冒泡通道）——**agent 看得见失败，能自纠重试**

`packages/api/src/mcp/server.ts` 参数描述改为明示：花名 or provider id 均可、勿带 @。

## 验证

- `callbacks.trigger-mention-error.test.ts`：`@范德彪`→归一 `范德彪`；`codex`→`范德彪`；`CODEX` 大小写不敏感；`@@范德彪` 多重 @；未知目标→ok:false+status 广播+不调 triggerMention；错误文案含可用名单
- 真机回归：小孙手机 →"叫德彪"→ 仁勋 trigger_mention → 德彪派发成功 → 德彪终稿回投手机（F040 D15 溯源链）

## 关联

- 发现于 F040（外部 IM 渠道网关）AC9；修复随 `feat/F040-im-channel-gateway` 合 dev
- 家族教训：[F026 R-073] 同一条派发链上一次静默死亡（mentions=[] 严协议关卡）；本质同款——**派发链任何一环失败都必须冒泡到调用方，禁止假成功**
