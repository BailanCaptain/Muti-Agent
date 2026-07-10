# F040 Phase 2.6 — 飞书指挥面 Implementation Plan

**Feature:** F040 — `docs/features/F040-im-channel-gateway.md`（Phase 2.6 节，D19/D20）
**Goal:** 手机飞书上用英文斜杠命令完成建房/切房/换默认应答人/改房间级模型/看状态（owner-only fail-closed）；成员支持禁用（不只删）；回复卡片署名带模型型号；管理页补默认应答人下拉与命令手册；D20 概念清理。
**Acceptance Criteria:**（从 feature doc 逐条抄录）
- AC-N1: 命令面基建（owner-only fail-closed）：入站文本 `/` 开头且 sender=owner → 走命令管线（**不注入房间**，回执只回飞书）；非 owner 发已知命令 → 回执「仅群主可用」不注入；未知 `/xxx` → 提示 /help；命令处理异常不击穿入站主链
- AC-N2: 六命令全落（词表 D19）：`/rooms`｜`/newroom <名>`｜`/switch <R-号|名>`｜`/agent <花名>`｜`/model [R-号] [<agent> <型号> [强度] | <agent> default]`｜`/status`｜`/help`
- AC-N3: 成员**禁用**开关：channel_admin_members 加 `enabled` 列（含存量库 ALTER 迁移）；门检查 enabled=0 按非白名单拒；管理页成员行开关
- AC-N4: 回复卡片署名带模型型号（如 `黄仁勋 · opus-4-8`）
- AC-N5: 管理页增强：群行「默认应答人」下拉（与 /agent 同一原语）+ 命令参考手册节（渠道 tab 内）
- AC-N6: 渠道概念清理（D20）：演化废代码 sweep + 回执统一（unbound 改指 /newroom·管理页双路）+ 概念收敛结论落 doc；真机验收 = 小孙全词表过一遍

**Architecture:** 命令面是 gateway 的**门后旁路**（过白名单门 → `/` 前缀截流 → 不进入站账本不注入房间）；命令逻辑独立模块 `channel-commands.ts`（纯 parser + 依赖注入 executor），gateway 只做 owner 判定/幂等去重/回执，server.ts 装配业务依赖。/model 全量复用 F021 session-runtime-config（校验/pending 运行守卫/字段级合并）；/switch、/agent 与管理页共用 ChannelAdminStore 新原语（binding 是运行时真相源，D3/D20）。
**Tech Stack:** node:sqlite、Fastify、Next.js、既有 gateway/store 测试模式（真临时 SQLite + fake sender/injector）。

---

## 终态 Schema（Straight-Line：先钉终态，步骤只做加法）

### 1. 新表 `channel_command_audit`（命令幂等 + 特权审计，双职能）

```sql
CREATE TABLE IF NOT EXISTS channel_command_audit (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  external_chat_id TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  open_id TEXT NOT NULL,
  chat_kind TEXT NOT NULL CHECK(chat_kind IN ('p2p','group')),
  raw_text TEXT NOT NULL,             -- 原命令文本（≤512 截断落库）
  result TEXT NOT NULL DEFAULT 'received',  -- received | done | denied | error:<截断>
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel, external_chat_id, external_message_id)
);
```

**为什么不进 channel_inbound_ledger**：① ledger `state` 有 CHECK 闭集（queued/injected/rejected），扩枚举 = rebuild 迁移；② `binding_id NOT NULL`——未绑群里 owner 恰恰要能跑 `/newroom`，命令没有 binding 可挂。独立表 UNIQUE 三元组直接复用「WS 断线重连补推」的幂等打法（T4 真机观察过补推，`/newroom` 重放 = 重复建房，必须 durable 去重），顺带给特权命令面一条审计线（谁在什么时候跑了什么，D14 owner-only 的问责面）。**先登记后执行**：进程半途死 → 重放被去重（宁丢一次命令让人重敲，不重复建房）。

新表 = CREATE IF NOT EXISTS 自迁移；**三 DDL 面照齐**（sqlite.ts / schema.ts drizzle 镜像 / drizzle-instance.ts MIGRATIONS——P2 全量审 P2-1 教训：双迁移系统也要镜像）。

### 2. 存量表加列 `channel_admin_members.enabled`（AC-N3，四脸迁移）

```sql
-- sqlite.ts CREATE TABLE 内：
enabled INTEGER NOT NULL DEFAULT 1
-- sqlite.ts runAlterMigrations 追加（存量库）：
ALTER TABLE channel_admin_members ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1
```

四张脸一把梳齐：① sqlite.ts CREATE ② sqlite.ts ALTER ③ schema.ts drizzle 镜像 ④ drizzle-instance.ts MIGRATIONS（CREATE 串 + ALTER）。

**语义**：`enabled=0` = 按非白名单拒（p2p 走 allowlist 拒、群走 member-not-allowed 拒，都进待放行审计——被禁成员再敲门 owner 看得见）。`getAuthView()` 只装 enabled 成员（owner 名单、groupMembers 归因映射都过滤）→ **禁用的 owner 也进不了命令面**（fail-closed 免费拿到）。

**守卫矩阵全部换成「enabled owner 数」**（旧 countOwners 有洞：两 owner 一禁一活时删活的 = 全锁）：

| 操作 | 拦截条件 |
|------|----------|
| DELETE member | 目标是 enabled owner 且 enabledOwners ≤ 1 → 400 |
| PATCH role 降级 | 同上（目标 enabled owner + 降级 + ≤1）→ 400 |
| PATCH enabled=false | 目标是 enabled owner 且 enabledOwners ≤ 1 → 400（「最后一个可用 owner 不能禁用」） |
| POST audits/:id/allow 覆写 | existing 是 enabled owner 且 role≠owner 且 enabledOwners ≤ 1 → 400 |

禁用态的 owner 删/降级**放行**（不减少可用 owner 数，不构成自锁）。`allowFromAudit` 的 member upsert 显式 `enabled=1`（放行 = 可用）；`upsertMember` 的 ON CONFLICT **不碰 enabled**（改名/改角色不悄悄复活禁用成员）。

### 3. 出站署名带型号（AC-N4，合同加法）

```typescript
// channel-types.ts
export type FinalMessage = { content; senderAlias; createdAt; orderSeq; model: string | null }  // += model
export type ChannelSender = { sendText(chatId, text, opts?: { senderAlias?; model?: string | null }) }
```

- 数据源 = `messages.model`（F021 Phase 5 逐消息模型快照，**追加时冻结**——正是「这条回复实际用的什么」，比 config 现读诚实）；`readFinalMessageFromDb` SELECT 加一列。
- feishu-sender：header title = `model ? `${alias} · ${model}` : alias`；**配色仍按花名 key**（HEADER_TEMPLATE_BY_ALIAS 查找不变）；文本兜底前缀 `【花名 · 型号】`。model 显示 messages.model 原文（零维护映射；小孙例 `opus-4-8` 是示意，真值如 `claude-opus-4-8` 一行放得下）。
- 老数据/relay 消息 model 为 null → 优雅退回纯花名。

### 4. ChannelAdminStore 扩绑定原语（/switch、/agent、管理页下拉三入口共用）

```typescript
getBinding(chatId): { sessionGroupId: string; defaultProvider: string } | null   // 读 channel_bindings
rebindChat(chatId, chatKind, sessionGroupId, opts: { defaultProvider: string }): void
//   tx：群 → 同步 channel_admin_groups.session_group_id 种子（复用 upsertGroup 语义）；
//   binding 行存在 UPDATE session_group_id，不存在 INSERT（chat_kind/default_provider 用参数）——
//   与 getOrCreateBinding 播种同构，命令面把「等第一条消息才建 binding」变成「立即建」。
setDefaultResponder(chatId, chatKind, provider, opts: { seedSessionGroupId: string | null }): void
//   binding 行存在 UPDATE default_provider；不存在且有 seed → INSERT；无 seed → throw（群先绑房）。
```

**不给 channel_admin_groups 加 default_provider 列**——binding 行（channel_bindings.default_provider）就是既有存储，D20 语义下 binding 自助化而非再造一层种子。管理页群行下拉 = PATCH groups/:chatId 带 `defaultProvider`（校验 ∈ PROVIDERS），路由内调 setDefaultResponder（seed = 该群 admin 行的 sessionGroupId ?? 现 binding）；overview 群行回 `effectiveDefaultProvider`（binding ?? 渠道默认）。

### 5. 命令面合同（AC-N1/N2）

```typescript
// channel-commands.ts（新模块）
export type ParsedCommand =
  | { kind: "rooms" } | { kind: "help" } | { kind: "status" }
  | { kind: "newroom"; title: string }
  | { kind: "switch"; target: string }            // R-号（大小写不敏感）或房间名
  | { kind: "agent"; target: string }              // 花名/provider id（resolveMentionTarget 复用）
  | { kind: "model"; roomRef: string | null;       // R-号定位；null=当前房
      action: { type: "show" } | { type: "show-agent"; agent: string }
            | { type: "set"; agent: string; model: string; effort?: string }
            | { type: "clear"; agent: string } }
  | { kind: "unknown"; word: string }
export function parseCommand(text: string): ParsedCommand   // 纯函数，重单测

export type CommandContext = {
  chatId: string; chatKind: ChatKind; senderOpenId: string
  binding: { sessionGroupId: string; defaultProvider: string } | null   // gateway 现查，不创建
  channelDefaults: { bindSessionGroup: string; defaultProvider: string }
}
export class ChannelCommandExecutor {
  constructor(deps: CommandExecutorDeps)
  async execute(cmd: ParsedCommand, ctx: CommandContext): Promise<string>  // 返回回执文本（markdown）
}
export type CommandExecutorDeps = {
  adminStore: ChannelAdminStore                      // rebindChat / setDefaultResponder / getBinding
  rooms: {
    list(): Array<{ id; roomId: string | null; title }>          // 活房间（archived/deleted 排除）
    create(title: string): { id; roomId: string | null; title }  // sessionService.createSessionGroup(title)
    get(id: string): { id; roomId; title } | null
  }
  runtimeConfig: {
    getGlobal(): RuntimeConfig                       // loadRuntimeConfig()
    getSession(groupId): Record<string, unknown>     // repository 四件套原样
    setSession(groupId, cfg): void
    getPending(groupId): Record<string, unknown>
    setPending(groupId, cfg): void
  }
  findThread(groupId, provider): { id: string; currentModel: string | null } | null
  isBusy(groupId, provider): boolean                 // injector.getBusyStatus(threadId, groupId) != null
}
```

**gateway 侧**（`ChannelGatewayDeps` 加可选 `commands?: { execute(cmd, ctx): Promise<string> }`，缺省 = 命令面关，全部既有测试零翻改）：

```
handleInbound：
  门（p2p allowlist / 群双白名单+@bot）        ← 不动，陌生人摸不到命令面
  ↓ text.trim() 以 "/" 开头 且 commands 已注入
  handleCommand(msg)：                          ← 在 getOrCreateBinding 之前（未绑群可 /newroom //switch）
    1. tryInsertCommandAudit（UNIQUE 冲突 → "command_duplicate"，静默不回执）
    2. isOwner = cfg().allowedOpenIds.includes(sender)
       非 owner → 回执「命令面仅群主可用」+ audit result=denied → "command_denied"
    3. parseCommand → executor.execute（try/catch 全包）
       成功 → 回执 + result=done；异常 → 回执「命令执行失败：…」+ result=error:…
       无论如何 return "command_handled"        ← 永不掉进注入链（AC-N1 异常不击穿）
  ↓ 非命令 → 原链原样（binding → 账本 → drain）
InboundResult += "command_handled" | "command_denied" | "command_duplicate"
```

**语义决定（记入 D19 执行细则）**：
- `/` 前缀整体保留给命令面：非 owner 发**任何** `/` 开头文本 → 「仅群主可用」（不区分已知/未知——不向 participant 泄词表，fail-closed 最简一致）；owner 发未知 `/xxx` → /help 提示。AC-N1 两分句照面兑现。
- 命令消息**不进** inbound ledger / 不注入房间 / 不产生归因前缀——回执只回飞书（AC-N1 定义）。
- 群里要 @bot 才到命令面（群门既有要素，@bot 剥离后 `/` 判定成立）。

### 6. 六命令行为表（D19 词表逐条）

| 命令 | 行为 | 回执要点 |
|------|------|----------|
| `/rooms` | 列活房间 | 每行 `R-001 房间名`，当前绑定房标 `←当前`；未绑群提示 /switch·/newroom |
| `/newroom <名>` | 建房（title trim 1-40，与 PATCH 路由同约束）+ 当前对话换绑一步（rebindChat） | `已建 R-00X 名 并把本对话绑定过去` |
| `/switch <R-号\|名>` | R-号大小写不敏感精确匹配；否则按 title 精确匹配；多个同名 → 列候选让用 R-号；找不到 → 指 /rooms | `本对话已切到 R-00X 名` |
| `/agent <花名>` | `resolveMentionTarget`（callbacks.ts:34 复用：剥@/花名精确/provider id 大小写不敏感）→ provider → setDefaultResponder（binding 级，热生效——binding 每次 drain 现读） | `本对话默认应答人已改为 范德彪（codex）`；未绑群 → 先 /switch 或 /newroom |
| `/model` 读 | 无参=当前房全 agent；`R-002`=目标房；`+ <agent>`=单个 | 每 agent 一行：生效 model/effort + 来源标注（房间覆盖/全局/默认=thread.currentModel/CLI 默认） |
| `/model … set` | `[R-号] <agent> <型号> [强度]`：型号过格式闸（见下）+ effort 按 MODEL_CATALOG[provider].efforts 闭集（gemini → 「不支持强度」）；**busy → 写 pending 回执「运行中，下轮生效」；空闲 → 写 config「已生效」**（F021 3.3 同语义；configSnapshot 派发时冻结，正确性两路等价，pending 只是归档语义） | 回显生效值+作用域 |
| `/model … default` | `<agent> default`：session config 该 agent 项**只清 model+effort**（保 contextWindow/sealPct——网页设置的字段不被手机一刀清）| `已还原 <agent> 为全局设置` |
| `/status` | 当前房 R-号+名、默认应答人花名、逐 agent 生效模型（同 /model 读）| 未绑群 → 引导文案 |
| `/help` | 词表+一行示例（与管理页手册同文案源） | — |

**/model 型号格式闸（安全）**：命令文本来自 IM，model 最终进 CLI spawn argv——沿用 runtime-config.ts:59-69 的既有结论（cmd.exe 元字符注入 + `-`-开头 flag 注入），executor 写前按 `^[A-Za-z0-9][A-Za-z0-9._:/-]*$` ≤64 校验（真实 model id 全通过，零功能代价）。写入仍走 `validateSessionRuntimeConfigInput` 全套（双闸）。

**/model busy 判定取舍**：busy = `isBusy(目标房, agent)`（A2A slot）；feishu 直发 turn 不占 slot（P1-1 既有事实），当前对话可叠 gateway inflight 兜底，**远程 R-号房的 direct-turn 窗口不追**——误判只影响「写 config 还是 pending」的归档语义，派发快照冻结保证不半途生效，正确性无损（doc 记取舍）。

### 7. server.ts 装配（谁给依赖）

feishu 块内组 executor（全部现成对象）：`adminStore=channelAdminStore`；`rooms.create` = `sessionService.createSessionGroup(title)`（service 加 title 透传参数，repo 早收 title；POST /api/session-groups 现行为零变化）+ `repository.getSessionGroupById` 取 R-号；`rooms.list` = 管理路由同款活房间 SQL；`runtimeConfig` 四件 = `repository` 直连（session-runtime-config 路由同源）；`findThread`/`isBusy` = `sessions.findThreadByGroupAndProvider` + `messages.getBusyStatus`。`WireFeishuDeps` 加可选 `commands`，wire 透传给 gateway。

---

## Tasks（TDD：每 task 红先绿后，一 task 一 commit 过全量门禁）

**顺序 = 小件先行（N3/N4/N5）→ 命令面大头（N1/N2）→ 清扫（N6）**，小孙拍板原话顺序。

- **T1（AC-N3 后端）**：enabled 四脸迁移 + store（getAuthView 过滤/countEnabledOwners/setMemberEnabled/allowFromAudit enabled=1/upsertMember 不碰 enabled）+ 路由守卫矩阵四条 + listMembers 带 enabled。测试：存量库 ALTER 幂等、禁用成员门拒（p2p/群两路，hot-config 面）、守卫矩阵正反例（含「禁一活一删活的」自锁反例）、审计再放行复活。
- **T2（AC-N3 前端 + AC-N4）**：MemberRow 开关+已禁用 chip+hook enabled；reader SELECT model + 类型加法 + sender 署名头/兜底 + gateway 透传。测试：reader 真表 model 四路、sender 卡片 JSON title 断言、E2E 成员禁用开关落库断言。
- **T3（AC-N5 后端）**：store getBinding/rebindChat/setDefaultResponder + PATCH groups defaultProvider + overview effectiveDefaultProvider。测试：rebind 未绑群 INSERT/已绑 UPDATE 同事务、defaultProvider 热生效（下一条消息注入到新 provider）、无房种子 throw。
- **T4（AC-N5 前端）**：群行默认应答人下拉 + 渠道 tab 命令手册节（静态词表）。E2E 下拉断言。
- **T5（AC-N1 基建）**：channel_command_audit 三 DDL + gateway 拦截（顺位/owner 门/幂等/异常包裹/回执）+ InboundResult 三态。测试：owner 命中、非 owner 拒、重复静默、executor 抛异常回执且主链活着、未绑群命令可达、`/` 非命令文本不受影响（无 commands dep 时零变化）。
- **T6（AC-N2 五命令）**：parseCommand 纯函数矩阵 + executor rooms/newroom/switch/agent/status/help（真临时 sqlite + fake rooms/runtimeConfig）。含歧义名、R-号大小写、title 边界、未绑群引导。
- **T7（AC-N2 /model）**：读/写/清全路径 + 双闸校验 + busy→pending + R-号定位 + gemini 强度拒。测试矩阵含注入串拒收（`; rm`、`--yolo`、超长）。
- **T8（装配）**：server.ts deps + service title 透传 + wire 透传 + feishu-connector 全链测试（owner /newroom→房落库+binding 换绑+回执文本；/model set→session config 落库）。
- **T9（AC-N6）**：unbound 回执改指 /newroom·管理页双路；废代码 sweep（候选：wireFeishuConnector 静态 config 分支的去留核实、Phase 1 遗留文案、channel-config 注释过时口径——**逐条核 HEAD 活性再动手**，Trace-Output-Consumers 纪律）；D20 结论段落 feature doc。
- **T10（收口）**：quality-gate 亲验 → 零上下文 guardian → 真德彪 codex 审收敛 → 预览带配置重启 → 小孙真机全词表 → AC 全勾 + Timeline。

## YAGNI 边界（本期不做）

- 命令别名/缩写（`/r` `/m`）、中文命令、模糊房名匹配——词表 D19 拍死英文全称。
- 命令面分页（房间 >50 截断提示用管理页）——小孙单人场景。
- channel_admin_groups.default_provider 种子列（binding 即存储，见 §4）。
- /model 改全局 config（网页专属；命令面只动房间级，D19「爆炸半径=单房间」）。
- 命令回执卡片化署名头（纯文本 markdown 卡足够；署名头是 agent 终稿专属语义）。

## 已知坑（前车之鉴，本期直接规避）

- 三/四 DDL 面不同步（T10 `4871468` + P2 审 P2-1）：T1/T5 的 DDL 改动一把梳齐再跑测试。
- 门禁期间预览进程必停（全量测试 flake）；commit timeout 600000；`biome lint --write --unsafe` 只点名文件。
- shared 包类型改动（channel-types 在 api 包内，无此坑；若动 @multi-agent/shared 必先 build）。
- E2E 种子 id 唯一化（德彪 P2.5-r1 #3 模式）；playwright.config env「已设不覆盖」守卫已在。
- 测试 spawn git 无关本期；node:sqlite 行 null-prototype，deepEqual 前 spread。
