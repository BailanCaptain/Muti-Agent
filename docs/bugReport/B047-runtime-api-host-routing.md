# B047 — 生产前端固化不可达 API Host

> Related: F040
> Deployment contract: Web and API share one hostname; configured protocol/port/path remain authoritative.
> Review follow-up: internal `/uploads` image/file blocks now use the runtime API hostname while external media URLs remain unchanged. The poisoned-host E2E now requires a successful `/api/bootstrap` response and bootstrap-rendered session UI, not only a WebSocket connection.
> Cross-device follow-up: new browser uploads are persisted as root-relative `/uploads/...` URLs. Existing loopback absolute upload URLs remain compatible when the same conversation is opened through a Tailscale/LAN hostname.
> TAKEOVER follow-up: API-generated screenshot/file blocks must be persisted and broadcast as root-relative `/uploads/...`; callback responses remain absolute for compatibility.
> Status: TAKEOVER follow-up implemented and verified; pending independent review

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | 执行 `start-project.bat` 后 Web/API 均启动，但首页持续显示 `Connecting to realtime...`；TAKEOVER follow-up 发现 `take_screenshot` / `send_file` 还会把配置 host 的绝对 URL 写入消息账本与 WS block，配置切换后旧消息继续请求旧 host。 |
| 2 | **证据** | 浏览器侧原问题证据见下文；API follow-up 的 `packages/api/src/server.ts` 两条写入路径都先调用 `resolveUploadUrl`，再把所得 `absoluteUrl` 赋给 `block.url`（原行 802、845），同时 callback 也返回该绝对 URL。 |
| 3 | **假设** | 浏览器原根因是构建时 host 固化；API follow-up 根因是同一个 `absoluteUrl` 同时承担临时 callback 访问地址与长期 ContentBlock 存储地址，混淆了两种生命周期契约。 |
| 4 | **诊断策略** | 保持 callback response 的 absolute URL；让 server 实际调用的块构造逻辑为 screenshot/file 分别产出 root-relative block URL；测试同时捕获持久化输入、广播事件与 callback 返回值。 |
| 5 | **超时策略** | 30 分钟内若统一解析器无法覆盖 preview/E2E，则停止扩散修改，回查 F024/F040 环境注入契约。 |
| 6 | **预警策略** | 若修复需要修改 `.env`、API 数据目录或 runtime 配置，立即停止并交由小孙人工处理。 |
| 7 | **用户可见修正** | 首页从“正在连接”恢复为“实时连接成功”，会话及右侧面板能访问同机 API。 |
| 8 | **复现验收** | 原浏览器验收保持；新增 server 回归测试分别断言 screenshot/file 的持久化与广播 `block.url=/uploads/...`，且 callback `imageUrl/fileUrl=http://configured-host/...`；再跑 API tests、typecheck、build。 |

## Bug Report 六件套

### 1. 报告人

小孙于 2026-08-15 执行启动脚本后发现项目看似失效；范德彪通过进程、HTTP、构建产物和真实浏览器联合排查复现。

### 2. Bug 现象

`start-project.bat` 能正常拉起 Web/API，`http://localhost:8787/health` 也返回 200；但从
`http://localhost:3000` 打开的浏览器持续停在 `Connecting to realtime...`。生产 bundle
实际尝试连接 `ws://100.120.213.33:8787/ws`，而本机经该 Tailscale 地址访问自身会超时。

### 3. 复现步骤

1. 使用 Tailscale 地址配置 `NEXT_PUBLIC_API_HTTP_URL` / `NEXT_PUBLIC_API_WS_URL` 并构建前端。
2. 启动同机 Web/API，从 `http://localhost:3000` 打开首页。
3. 观察页面一直显示正在连接；浏览器 WebSocket 目标仍是构建时 Tailscale host。
4. 对照访问 `http://localhost:8787/health` 成功，访问同端口的 Tailscale 自地址超时。

### 4. 根因分析

浏览器消费者直接读取 `NEXT_PUBLIC_API_*`。Next.js 会把这些公开变量固化到前端产物，
导致“访问入口的 hostname”和“构建机器写入的 hostname”永久绑定。Web/API 虽然同机，
浏览器仍绕到不可达的 Tailscale 自访问路径，所以启动脚本显示 Ready 但产品不可用。

TAKEOVER follow-up 进一步定位到 API producer：`take_screenshot` 与 `send_file` 都把
`resolveUploadUrl` 生成的绝对 callback URL 直接复用为 `ContentBlock.url`。callback 是当前
调用方的即时访问合同，消息账本/WS block 是跨配置生命周期的长期数据，两种地址合同被
同一个变量耦合，导致切换 API hostname 后旧消息继续绑定旧入口。

### 5. 修复方案

新增 `lib/api-endpoints.ts` 作为浏览器 API 地址单一真相源：配置值继续决定协议、端口和
路径，浏览器运行时用 `window.location.hostname` 覆盖 host；SSR 保持配置原值。迁移全部
HTTP/WS 浏览器消费者，并让 E2E Web 构建接收一个故意不可达的保留地址，持续锁住回归。

TAKEOVER follow-up 把 server 实际注入 `registerCallbackRoutes` 的两个媒体 callback 抽到
`createAgentMediaCallbacks`：截图 block 使用 `captureScreenshot` 返回的 `/uploads/...`，
文件 block 使用落盘名构造 `/uploads/...`；两条 callback response 仍经 `resolveUploadUrl`
返回 absolute URL。不修改 resolver，不做历史数据迁移，也不把外部 CDN URL 泛化改写。

### 6. 验证方式

- 单元验红：旧 WebSocket client 实际收到 `ws://100.120.213.33:8787/ws`；修复后 6/6 通过。
- 浏览器验红：临时关闭 host 重写后，专项 E2E 准确收到 `192.0.2.1` 并失败。
- 浏览器验绿：恢复修复后，专项 E2E 连接 `ws://localhost:8999/ws`，页面显示“实时连接成功”。
- `pnpm run test:components`：89 files / 911 tests passed。
- `pnpm run typecheck`、`pnpm run build`、`pnpm run lint`：通过（lint 仅 75 条既有 warning）。
- 全量 E2E：B047 与其余 11 项通过；1 项既有日报标题断言失败，与本 diff 无关。
- TAKEOVER Red：`pnpm exec tsx --test packages/api/src/lib/agent-media-callbacks.test.ts` → 0 passed / 2 failed；两条 actual 都是 `http://100.120.213.33:8787/uploads/...`，expected 都是 `/uploads/...`。
- TAKEOVER Green：同命令 → 2 passed / 0 failed；截图/文件均锁 persisted + broadcast root-relative，且 callback response absolute。
- TAKEOVER focused API：27 passed / 0 failed（media callbacks、agent-file、resolve-upload-url、callback routes）。
- TAKEOVER 全量 API：4734 passed / 9 failed / 1 skipped / 1 todo；8 项因本机 WSL `/bin/bash` 缺失，1 项为既有 ADR-004 diff guard fixture；新增两例均通过，无新增失败。
- TAKEOVER `pnpm typecheck`、`pnpm build`：exit 0；`pnpm run test:components`：89 files / 920 tests passed；`pnpm lint`：exit 0（75 条既有 warning）。
