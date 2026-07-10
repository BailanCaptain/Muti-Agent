# F040 Phase 2.5 — 渠道管理页 Implementation Plan

**Feature:** F040 — `docs/features/F040-im-channel-gateway.md`（Phase 2.5 节，D17/D18）
**Goal:** 渠道授权配置（群白名单/成员白名单/群绑定/p2p 白名单）从 env 迁 SQLite 真相源 + 前端管理页一键放行，改动热生效不重启；env 降为首启种子。
**Acceptance Criteria:**（从 feature doc 逐条抄录）
- AC-M1: 渠道授权配置 DB 真相源；env 降为首启种子（对应表空时一次性导入，表非空以 DB 为准）；fail-closed 语义保持（表空且无种子 = 全拒，connector 启动条件不变）
- AC-M2: 配置改动热生效：管理面增删成员/群/绑定后，下一条入站消息即按新配置判定，无需重启（网关读配置走 DB-backed store，写路径失效缓存）
- AC-M3: 管理 API（fail-closed 校验）：群/成员/绑定 CRUD + 入站拒绝审计持久化 + 待放行查询 + 一键放行；绑定房间校验 room 存在；非法格式拒绝
- AC-M4: 前端「渠道管理」页：群列表（开关/绑定房间）+ 成员管理 + 待放行一键放行；E2E 覆盖核心路径 + 真机验收 = 小孙页面自配新成员 → 不重启 → 群内 @ 即通、署配置名

**Architecture:** 新增 `ChannelAdminStore`（DB-backed 授权配置 + 审计聚合，缓存快照写失效）；`ChannelGateway.deps.config` 收窄为 getter（每次门判定走快照）；四个拒绝点挂 `recordReject` 持久化；REST 路由 `routes/channel-admin.ts` 手写校验显式拒绝；前端新页复用现有组件 + F039 token。
**Tech Stack:** node:sqlite（drizzle schema 镜像）、Fastify、Next.js、Playwright（F038 harness）。

---

## 终态 Schema（Straight-Line：先钉终态，步骤只做加法）

### 三张新表（`packages/api/src/db/sqlite.ts` F040 渠道块内追加 + `schema.ts` 镜像；新表 = CREATE IF NOT EXISTS 自迁移，**不需要** ALTER/drizzle MIGRATIONS——四脸教训只对已存在表的加列成立）

```sql
CREATE TABLE IF NOT EXISTS channel_admin_members (
  channel TEXT NOT NULL,              -- 'feishu'（前瞻多渠道）
  open_id TEXT NOT NULL,
  display_name TEXT NOT NULL,         -- 归因署名（owner 命名，非用户自报）
  role TEXT NOT NULL CHECK(role IN ('owner','participant')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, open_id)
);
-- 语义：role='owner' ⇒ p2p 白名单 + 群 owner 全权（= 旧 FEISHU_ALLOWED_OPEN_IDS）
--       role='participant' ⇒ 仅群内可对话（= 旧 FEISHU_GROUP_MEMBERS 非 owner 项）
--       一张表吃掉两个 env 变量，与 channel-config.ts:119 派生规则同构。

CREATE TABLE IF NOT EXISTS channel_admin_groups (
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  session_group_id TEXT,              -- 绑定种子；绑定运行时真相源仍是 channel_bindings（D3）
  enabled INTEGER NOT NULL DEFAULT 1, -- 群开关：0 = 从白名单摘除（陌生群语义，静默拒）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, chat_id)
);

CREATE TABLE IF NOT EXISTS channel_inbound_audit (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_kind TEXT NOT NULL CHECK(chat_kind IN ('p2p','group')),
  open_id TEXT NOT NULL,
  reason TEXT NOT NULL,               -- allowlist | group-not-allowed | member-not-allowed | unbound
  count INTEGER NOT NULL DEFAULT 1,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','allowed','dismissed')),
  UNIQUE (channel, chat_kind, chat_id, open_id, reason)
);
-- recordReject = upsert：count+1 / last_at 刷新；status 不被重复拒绝改写
-- （dismissed 保持 dismissed，count 仍累计供观察）。ignored_no_mention 不入审计（设计即静默）。
```

### ChannelAdminStore（新模块 `packages/api/src/connectors/channel-admin-store.ts`）

```typescript
export class ChannelAdminStore {
  constructor(deps: { db: SqliteStore; channel: string; genId(): string; now(): string })
  // 读（AC-M2 热生效核）：组装快照 + 缓存；任何写方法先写库后 invalidate
  getAuthView(): {
    allowedOpenIds: string[]            // members WHERE role='owner'
    groupMembers: Record<string, { name: string; role: "owner" | "participant" }>
    allowedGroupChats: string[]         // groups WHERE enabled=1
    groupBindings: Record<string, string> // groups WHERE session_group_id IS NOT NULL
  }
  // 种子（AC-M1）：域独立判空——members 表空才导成员，groups 表空才导群；非空 DB wins
  seedFromEnv(cfg: { allowedOpenIds; groupMembers; allowedGroupChats; groupBindings }): { seededMembers: number; seededGroups: number }
  // 写（全部 invalidate）
  upsertMember(openId, displayName, role): void
  removeMember(openId): void            // 末位 owner 守卫在路由层（store 提供 countOwners()）
  upsertGroup(chatId, patch: { displayName?; sessionGroupId?; enabled? }): void
  //   ↑ sessionGroupId 变更时同事务 UPDATE channel_bindings 既有行（换绑热生效，AC-M2）
  removeGroup(chatId): void
  listMembers() / listGroups() / countOwners()
  // 审计（AC-M3）
  recordReject(r: { chatId; chatKind; openId; reason }): void   // 聚合 upsert
  listAudit(status?: "pending" | "allowed" | "dismissed"): AuditRow[]
  allowFromAudit(auditId, opts: { displayName; role }): void    // 事务：insert member + status='allowed'
  dismissAudit(auditId): void
}
```

### 网关改造（`channel-gateway.ts`，判定逻辑零改动）

```typescript
// deps.config: ChannelGatewayConfig | (() => ChannelGatewayConfig)
// 构造器归一化为私有 getter this.cfg()；~10 处 this.deps.config.X → this.cfg().X
// 既有测试传静态对象零翻改；热配置测试传可变闭包。
// 新增可选 dep：recordReject?: (r: { chatId; chatKind; openId; reason }) => void
// 四个拒绝点（rejected_allowlist / rejected_group / rejected_member / rejected_unbound）
// 在既有 audit() 旁调用；异常吞掉不击穿入站主链（try/catch + audit）。
```

### boot 接线（`feishu-connector.ts` wireFeishuConnector + `server.ts`）

**🔴 单例约束（热生效正确性的根）**：connector 用独立 SqliteStore 连接（server.ts:842 双连接既有事实）。
若路由和网关各建 ChannelAdminStore，路由写走实例 A、网关读走实例 B 的**缓存**——B 永不失效，AC-M2 破功。
所以：**server.ts 无条件构建唯一 ChannelAdminStore 实例**（connector disabled 时管理页照常可用），
路由注册和 wireFeishuConnector 共享同一实例（缓存失效在实例内闭环；SQLite 跨连接可见性 WAL 即时，无碍）。

```typescript
// server.ts（feishu 块外，无条件）：
const channelAdminStore = new ChannelAdminStore({ db: channelDb, channel: "feishu", genId, now })
registerChannelAdminRoutes(app, { adminStore: channelAdminStore, db: mainStore /* room 校验/名字 join */ })
// wireFeishuConnector deps += adminStore；内部：
adminStore.seedFromEnv(cfg)   // enabled 才 seed（表空才导）；启动日志打 seeded 计数
const gateway = new ChannelGateway({
  ...,
  config: () => ({ connectorId: "feishu", bindSessionGroup, defaultProvider, ...adminStore.getAuthView() }),
  recordReject: (r) => adminStore.recordReject(r),
})
// AC1 boot 条件不变：REQUIRED env 照旧（D5 verbatim）；env 白名单自 seed 后仅是种子，DB wins。
```

### 管理 API（新 `packages/api/src/routes/channel-admin.ts`，runtime-config.ts 风格：手写校验显式 400）

```
GET    /api/channel-admin/overview            → { members, groups(+live binding 房间名), pendingAudits }
POST   /api/channel-admin/members             { openId, displayName, role? }   格式校验（非空/trim/长度/控制字符拒）
PATCH  /api/channel-admin/members/:openId     { displayName?, role? }
DELETE /api/channel-admin/members/:openId     末位 owner → 400（防自锁：表非空 seed 不再跑，删光 owner = p2p 永锁）
POST   /api/channel-admin/groups              { chatId, displayName?, sessionGroupId? }
PATCH  /api/channel-admin/groups/:chatId      { displayName?, sessionGroupId?, enabled? }  sessionGroupId 必须存在于 session_groups
DELETE /api/channel-admin/groups/:chatId
GET    /api/channel-admin/audits?status=pending
POST   /api/channel-admin/audits/:id/allow    { displayName, role='participant' }
POST   /api/channel-admin/audits/:id/dismiss
```

### 前端（Explore 摸底已钉死 2026-07-04）

**载体拍板：SettingsModal 新增「渠道」tab**（`components/chat/settings-modal.tsx:8` TABS 加项）——
渠道授权语义上就是设置；复用既有 tab 骨架零新 shell；内容独立成组件防模态文件膨胀。

- `components/chat/channel-admin/use-channel-admin-api.ts`：数据 hook（约定=每资源一 hook，
  自带 `const baseUrl = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"`，typed 响应镜像路由）
- `components/chat/channel-admin/channel-admin-tab.tsx`：三节纵排
  1. **待放行**（愿景核心=「点一下就放行」）：行=open_id(mono)+reason chip+次数+last_at+昵称输入+「放行」「忽略」；参考 draft-approval-tab.tsx 动作行样式
  2. **成员**：行=昵称(可改)+role chip(owner/participant)+open_id(mono)+移除(confirm-dialog.tsx)
  3. **群**：行=群名(可改)+chat_id(mono)+启用开关(room-switches.tsx 样式)+绑定房间下拉(session groups 列表)+移除
- 样式纪律（F039）：只用 tailwind.config.ts 语义 utilities（surface/accent/rounded-field|card|panel/shadow token），
  **零裸 hex**；lucide 图标；三节各配空态文案
- 无共享 UI 库 = 类名模式从 settings-modal / draft-approval-tab / room-switches / confirm-dialog 抄

---

## Tasks（TDD：每步失败测试先行；commit 全量门禁期间停预览、timeout 600000）

### M-T1: DDL 三表 + schema.ts 镜像
1. 失败测试 `packages/api/src/db/channel-admin-tables.test.ts`：pragma 查三表列全 + CHECK/UNIQUE 约束（复用 messages-sender-column.test.ts 模式）
2. sqlite.ts F040 块追加三表 + schema.ts 镜像（channelAdminMembers/channelAdminGroups/channelInboundAudit）
3. 绿 + commit `feat(F040-M1): 渠道管理三表 DDL`

### M-T2: ChannelAdminStore 读/种子/成员群 CRUD
1. 失败测试 `channel-admin-store.test.ts`：
   - seedFromEnv 表空导入（owner 派生同 channel-config:119；owner 无名默认「村长」）
   - seed 幂等：表非空重跑零写入（DB wins）；域独立（members 空 groups 非空 → 只导 members）
   - getAuthView 快照正确性：role 过滤 / enabled=0 摘除 / sessionGroupId NULL 不出 bindings
   - 写后失效：upsertMember → getAuthView 立即含新成员（AC-M2 核心语义单测）
2. 实现 store（纯 SQL prepared statements，无 ORM 运行时依赖——与 gateway 同风格）
3. 绿 + commit

### M-T3: 审计聚合 + 放行事务
1. 失败测试：recordReject 首次 insert / 重复 upsert count+1 + last_at 刷新 + status 不回退；listAudit 过滤；allowFromAudit 事务（member 落 + status=allowed + 快照即时可见）；dismiss
2. 实现 + 绿 + commit

### M-T4: 网关 getter 化 + recordReject 挂点
1. 失败测试 `channel-gateway.hot-config.test.ts`：
   - 可变闭包配置：陌生成员拒 → upsertMember → 同一 gateway 实例下一条即过（不重启）
   - 关群（enabled=0 语义由闭包模拟）→ 静默拒
   - 四拒绝点 recordReject 各收到正确 reason/openId/chatId（spy）；recordReject 抛异常不击穿注入链
2. deps.config union + 构造器归一化 + ~10 处读点替换 + 四点挂钩
3. 全量 connectors 测试回归绿（既有 8 套零翻改验证归一化兼容）+ commit

### M-T5: boot 接线
1. 失败测试（feishu-connector.test.ts 增）：wire 后 store seeded + gateway 用 DB 配置判门（fake transport 注入陌生成员事件 → 拒；store 加人 → 过）
2. wireFeishuConnector + server.ts 接线（adminStore 单例供路由）
3. 绿 + commit

### M-T6: 管理 API 路由
1. 失败测试 `routes/channel-admin.test.ts`（fastify inject）：CRUD 正反例 / 末位 owner 删 400 / sessionGroupId 不存在 400 / open_id 控制字符 400 / allow 后 overview 反映
2. 实现 + server.ts 注册 + 绿 + commit

### M-T7: 换绑热更 channel_bindings
1. 失败测试：既有 binding 行 + upsertGroup 换 sessionGroupId → binding 行同事务更新 → 下一条群消息注入新 room（gateway 集成）
2. 实现 + 绿 + commit

### M-T8: 前端页面
1. use-channel-admin-api.ts hook（overview + mutations，typed）
2. channel-admin-tab.tsx 三节（结构见终态 schema 前端节）+ settings-modal 挂 tab
3. 手动 smoke（页面渲染/空态/一次真 CRUD 走通）+ commit

### M-T9: Playwright E2E（F038 harness，tests/e2e/channel-admin.spec.ts）
1. 成员 CRUD：真点击加成员 → `request.get` API 独立断言落库（session-groups.spec 模式，不数 DOM）
2. 群 add + 开关 toggle → API 断言 enabled 翻转
3. 放行流：spec 侧直写 harness temp SQLite 种一条 pending 审计行 → 页面点「放行」→ API 断言 member 落库 + 审计 status=allowed
4. 纪律：getByTestId/getByRole、零 waitForTimeout、**禁 @agent 消息**（F038 教训）；先验红后验绿
### M-T10: quality-gate → 零上下文 guardian → 真德彪全量审 → 真机自配验收（AC-M4 收口）

## 不做什么（YAGNI 边界）

- 不做多渠道 UI（表带 channel 列前瞻，页面只呈现 feishu）
- 不做成员分群授权（保持现行全局 map 语义——gateGroup:212 同构；分群是未来 feature）
- 不做审计自动过期/分页（量级=拒绝事件，聚合后行数 ≪ 100）
- 不改 AC1 boot 条件 / p2p 门 / FIFO / 出站链路任何语义
