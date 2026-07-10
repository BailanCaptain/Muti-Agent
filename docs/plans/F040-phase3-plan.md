# F040 Phase 3 实施计划 — 体验强化（AC14 PWA / AC15 流式占位卡 / AC16 图片文件）

> 2026-07-05 立项。Phase 2.6 真机关账（`043bb84`）后小孙拍「往下继续推进」。
> 方法论沿 P2.6：终态 schema 先行 → TDD 小步 commit → 三重审 → 真机。
> **合并纪律不变：全 feature（含本 Phase）做完才合 dev。**

## 0. Premise 实测记录（2026-07-05，全部 file:line 亲核/Explore 核）

| 事实 | 证据 |
|---|---|
| 出站不走 SDK，走 SafeHttpClient 直连 REST；SDK 只管 WS 事件 | feishu-sender.ts:70（POST MESSAGES_URL）|
| SafeHttpClient method 已含 PATCH；body 仅 jsonBody；响应仅文本（默认 2MB） | net/safe-http-client.ts:36-47 |
| 入站 parser 非 text 一律 skip | feishu-event-parser.ts:83-84 |
| gateway 已订阅 invocation.finished/failed；sweeper 已有 | channel-gateway.ts:430,474,734 |
| PWA 零现状：无 manifest/图标/viewport/apple meta/public 目录/SW | app/layout.tsx:13-32；next.config.ts:8-16 |
| ContentBlock = text \| image，无 file | packages/shared/src/realtime.ts:67-69 |
| image 前端渲染全套（缩略图+lightbox）；normalizeMessageToBlocks 只吃 image | lib/blocks.ts:111-122；components/chat/rich-blocks/image-block.tsx |
| 存储约定：content_blocks JSON 列 + 磁盘 uploadsDir(.runtime/uploads) + /uploads 静态服务，无附件表 | db/schema.ts:83；config.ts:41；server.ts:616-618 |
| agent 出图链路已有（take_screenshot → appendContentBlock → WS 广播） | server.ts:768-801 |
| web 上传仅 image MIME 10MB（@fastify/multipart 已注册） | routes/uploads.ts:10-54；server.ts:612 |
| web 房间已真流式（空 assistant 行占位 + assistant_delta + 周期落库） | message-service.ts:1583-1607,1868-1887 |

## 1. 终态 schema / 契约（先行冻结）

### 1.1 channel_inbound_ledger 新列（AC15 占位卡，三 DDL 面一把梳齐）

```sql
-- sqlite.ts CREATE 内联 + runAlterMigrations ALTER + schema.ts drizzle 镜像
placeholder_message_id TEXT,            -- 飞书占位卡 message_id；NULL=没发过/不适用
placeholder_state TEXT                  -- NULL | 'sent' | 'replaced' | 'failed' | 'expired'
  CHECK (placeholder_state IN ('sent','replaced','failed','expired'))
```

状态机：`sent`（注入成功随手发）→ `replaced`（root 链第一个按序 final PATCH 成正式卡）｜`failed`（invocation.failed 且 root 无 sent/pending final → PATCH 成失败文案）｜`expired`（sweeper 超时 → PATCH 成超时文案）。**发卡失败不阻断入站主链**（audit 记录，placeholder 字段留 NULL，终稿走正常 POST）。

### 1.2 ChannelSender 接口扩展（AC15+AC16，optional 防 13 个 fake 全 churn——P2.6 N4 教训）

```typescript
export type ChannelSender = {
  send(...): Promise<SendResult>                    // 现有
  sendPlaceholder?(chatId: string): Promise<{ ok: true; messageId: string } | { ok: false; error: string }>
  patchCard?(messageId: string, opts: { text: string; senderAlias?: string | null; model?: string | null }): Promise<{ ok: boolean; error?: string }>
  sendMedia?(chatId: string, media: { kind: "image" | "file"; name: string; data: Uint8Array }): Promise<SendResult>
  // 落地修正（T6）：localPath → data 字节——fs 读取集中在 wire 装配层（readUploadFile，
  // basename 防穿越），sender 保持纯网络面无文件系统依赖（可测性+职责单一）
}
```

gateway 全部 `sender.sendPlaceholder?.()` 可选调用：未实现的渠道自动没有占位卡/媒体，行为=现状。

### 1.3 SafeHttpRequestOptions 扩展（AC16，F029 安全纪律：SSRF/上限面不动，只加形态）

```typescript
// 新增（与 jsonBody 互斥）：
rawBody?: { contentType: string; body: Buffer }     // multipart 手拼（boundary 自管）
responseAs?: "text" | "buffer"                       // 默认 text；buffer 走同 maxBytes 闸
```

### 1.4 ContentBlock file 类型（AC16，shared 改后必 build——TS2353 坑）

```typescript
| { type: "file"; url: string; name: string; size?: number; mime?: string }
```

### 1.5 InboundMessage 附件（AC16 入站；下载归 connector 层，gateway 保持渠道无关）

```typescript
attachments?: Array<{ kind: "image" | "file"; url: string; name: string }>
// connector 收到 image/file 事件 → 用 tenant token 下载 resources → 写 uploadsDir（UUID+扩展名白名单）
// → 给 gateway 的 attachments 已是本地 /uploads/xxx；text 置「[图片]」/「[文件] 名字」标签
```

### 1.6 app/manifest.ts + 图标 + viewport（AC14，Next App Router 官方形态零插件）

```typescript
// app/manifest.ts：MetadataRoute.Manifest
{ name: "Multi-Agent", short_name: "Multi-Agent", display: "standalone",
  start_url: "/", theme_color/background_color: 取 F036 暖金系 CSS 变量终值,
  icons: [{ src: "/icon", sizes: "512x512" }, ...] }
// app/icon.tsx + app/apple-icon.tsx：next/og ImageResponse 画字标（深底暖金「多」/「MA」）
//   fallback（若 ImageResponse 在本 Next 版本/nodejs runtime 受限）：脚本用仓内 Playwright 渲染 SVG 截 PNG 落 app/
//   落地修正（T1）：字标 → 纯几何三金点品字（satori 只内置 Inter latin，中文渲染成豆腐块；
//   共用 app/pwa-icon-art.tsx 按 canvas 比例缩放）
// app/layout.tsx：export const viewport = { themeColor, viewportFit: "cover" }
//   + metadata.appleWebApp = { capable: true, statusBarStyle: "black-translucent", title: "Multi-Agent" }
//   落地修正（T1）：viewportFit 不加（无刘海贴边诉求，YAGNI）；statusBarStyle = "default"
//   （black-translucent 会让内容顶进状态栏区，浅色主题下可读性反而差）；
//   Next 16 把 appleWebApp.capable 渲染成新标准名 meta[name="mobile-web-app-capable"]
//   （generate/basic.js:263，e2e 断言以此为准）
```

### 1.7 飞书 REST 端点（AC15/16；文档假设，T-校准真机冻结——P2 T4 模式零改 parser 的打法）

| 用途 | 端点 | 备注 |
|---|---|---|
| 编辑卡片 | `PATCH /open-apis/im/v1/messages/:message_id` | body=interactive card content |
| 上传图片 | `POST /open-apis/im/v1/images`（multipart: image_type=message, image） | 返 image_key |
| 上传文件 | `POST /open-apis/im/v1/files`（multipart: file_type, file_name, file） | 返 file_key |
| 下载入站资源 | `GET /open-apis/im/v1/messages/:message_id/resources/:file_key?type=image\|file` | 二进制 |
| 发图片/文件消息 | 现有 MESSAGES_URL，msg_type=image/file，content={image_key}/{file_key} | |

## 2. 任务分解（TDD，每 task 一 commit 过全量门禁）

- **T1（AC14）PWA 全套**：manifest.ts + icon.tsx/apple-icon.tsx + viewport/appleWebApp + `docs/guides/F040-pwa-private-network.md`（Tailscale/蒲公英装机指引+安全说明：D18 无认证故必须私有组网，公网暴露=裸奔，指引里写死）。验证=单测/轻 e2e 断 manifest 可达+关键字段+layout meta。（落地修正：docs 实际落 `docs/methods/F040-pwa-private-network.md`——methods 是仓内既有惯例目录，guides 不存在）
- **T2（AC15）占位卡**：① 三 DDL 面新列+迁移测试 ② FeishuSender sendPlaceholder/patchCard（卡片 JSON 复用现有署名头，占位=「⏳ 思考中…」灰头）③ gateway：注入成功发卡（fire-and-forget）；claimAndSend root 链第一个 sent 的 final PATCH（标 replaced，后续 final 正常 POST）；failed 收尾；sweeper 捎带 expired。测试=状态机矩阵（sent→replaced/failed/expired+发卡失败不阻断+命令面/拒绝不发卡）+ sender 卡片 JSON + wire。（落地修正：占位卡**无署名头**纯 markdown——发卡时刻还不知道哪个 agent 接单，预署名会说谎；patchCard 收尾文案同样无头）
- **T3（AC16a）通用文件底座（web 侧，不碰飞书）**：shared file 类型+build → uploads MIME/大小策略扩展（白名单加常见文档类，20MB；可执行类拒） → 前端 file block 渲染器（名+大小+下载）+ normalizeMessageToBlocks file 分支 + composer accept 放宽。测试=uploads 路由矩阵+渲染单测。（落地修正：uploads 策略扩展 + composer accept 放宽整段 YAGNI 砍——入站附件由 connector 下载落盘（T5 EXT_ALLOWLIST 是真闸），web 端手动上传文件入口无诉求，别为不存在的入口开攻击面）
- **T4（AC16b）SafeHttpClient 形态扩展**：rawBody + responseAs:"buffer"（multipart 手拼 helper 含 boundary 随机化+文件名转义）。测试=echo 服务器往返+maxBytes 闸对 buffer 生效+互斥校验。
- **T5（AC16c）飞书入站媒体**：event-parser image/file 分支（放行不再 skip）→ connector 下载落盘（UUID 文件名+扩展名白名单+大小闸）→ InboundMessage.attachments → gateway 注入房间（content=标签+contentBlocks）。测试=parser 三形态+下载失败降级（attachments 空但 text 标签仍注入）+全链 wire。
- **T6（AC16d）飞书出站媒体**：claimAndSend 读 final contentBlocks → image/file 逐个 sendMedia（上传拿 key→发媒体消息，跟在署名卡后）→ 失败降级=卡片文本附「[附件发送失败]」。测试=sender 上传+发送序列 mock + gateway 编排。
- **T7 真机校准**：小孙手机发一张图+一个文件进群（入站原始 JSON 冻结 fixture）；agent 房间截图出站回飞书；占位卡肉眼看「思考中→终稿」编辑；PWA iPhone Safari 添加主屏。发现 schema 出入=当场修 parser（P2 T4 先例）。
- **T8 三重审**：quality-gate → 零上下文 guardian → 真德彪（`-c model_provider=openai`）。**审计 agent 跑动期间禁跑门禁/E2E（P2.6 互相误红坑）。**

顺序：T1 独立可先行；T2 独立；T3→T4→T5→T6 严格串行（类型→底座→入站→出站）；T7/T8 收尾。

## 3. YAGNI（明确不做）

- Service worker / 离线缓存 / next-pwa 插件（添加主屏不需要；D18 自用）
- 飞书真 token 级流式（API 限流物理不可行；占位卡即「等效体验」）
- 多用户认证 / 对外分发（D13/D18 拍死）
- 附件表 / blob 进库（磁盘+URL 约定已立且够用）
- 语音/视频消息、图文混排 post 消息（图片单发跟卡片后即可）
- 占位卡每 agent 一张（只发一张，root 链首个 final 替换）
- 中文命令别名 / 命令分页（P2.6 YAGNI 继承）

## 4. 已知坑（前车之鉴，动手前读一遍）

1. **三 DDL 面**：channel 表改列必须 sqlite.ts CREATE + runAlterMigrations + schema.ts 三处一把梳齐（P2 T10 教训；drizzle-instance.ts INIT_SQL 无 channel 表已核）。
2. **shared 改后必 pnpm build**，否则 api tsc TS2353（F029 坑）。
3. **fake sender 全 optional**：新方法一律 `?`，13 个测试 fake 零 churn（P2.6 N4 打法）。
4. **审计 agent 期间禁跑门禁/E2E**；门禁前杀预览（负载 flake 双坑）。
5. **长字符串走 Edit**，禁 heredoc-Python 三层转义（吃 `\n` 坑）。
6. **预览验证必硬重启**核新 pid（tsx watch 热重载不可信）。
7. multipart 手拼注意 CRLF 与 boundary 不出现在内容里；文件名过飞书要转义。
8. 入站附件文件名**绝不采用户原名落盘**（路径穿越面）：UUID+白名单扩展名，原名只进 ContentBlock.name 字段。
9. commit 必核 EXIT + rev-parse；timeout 600000。

## 5. 验收对齐（feature doc AC 措辞）

- AC14 勾条件：iPhone Safari 添加到主屏图标/名字/独立窗口正确 + 私有组网 docs 落盘。
- AC15 勾条件：真机看到「思考中→终稿」同一条消息原地变身；失败/超时不留死卡。
- AC16 勾条件：手机发图/文件进房间网页可看可下；agent 截图回飞书手机可看。
