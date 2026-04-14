# F008 开发基础设施 + 视觉证据链 Implementation Plan

**Feature:** F008 — `docs/features/F008-dev-infra-evidence-chain.md`
**Goal:** 让开发基础设施从"原始"升级到"可观测"——后端改完秒生效、前端能看图、系统有日志、agent 能截图
**Acceptance Criteria:**
- AC1: `pnpm run dev:api` 使用 tsx watch 直接运行 TS 源码，API 代码修改后自动重启
- AC2: prod 构建路径不受影响（pnpm build 仍走 tsc + node dist）
- AC3: shared 层新增 ContentBlock 类型，包含 `{ type: "image", url, alt?, meta? }`
- AC4: TimelineMessage 新增可选 `contentBlocks?: ContentBlock[]`
- AC5: 前端 BlockRenderer 支持 image kind，渲染 ImageBlock 组件（含 lightbox）
- AC6: 后端通过 @fastify/static 在 /uploads/ 路径提供静态文件服务
- AC7: normalizeMessageToBlocks() 能将 contentBlocks 中的 image 类型转换为前端 ImageBlock
- AC8: 基于 Fastify 内置 Pino 封装 createLogger(scope)
- AC9: Fastify 注册全局 app.setErrorHandler() 兜底
- AC10: WebSocket 连接/断开/消息收发有日志
- AC11: Agent 调度关键路径有日志
- AC12: 静默 catch 块改为 logger.error()（覆盖率 ≥ 80%）
- AC13: POST /api/uploads 端点，接收图片文件，存入 /uploads/，返回 URL
- AC14: ChatInput 支持文件上传（点击 + 粘贴）
- AC15: 后端 multipart 解析 + 图片验证（MIME/大小）
- AC16: 消息中的图片通过 contentBlocks 传递，前端正确渲染

**Architecture:** 四层递进修复。P0 改一个 script 实现 hot-reload；P1 在 shared 加 ContentBlock 类型 + 前端加 ImageBlock 渲染 + 后端加静态文件服务；P1.5 封装 logger 工具 + 覆盖关键路径日志；P2 加图片上传端点 + ChatInput 文件上传 UI。
**Tech Stack:** tsx(watch), @fastify/static, @fastify/multipart, Pino(Fastify 内置), Next.js Image, React(lightbox)

---

## Straight-Line Check

**Finish line (B):** 小孙打开项目后：改 API 代码自动重启、timeline 里能看到图片、出错有日志可查、能上传图片给 agent。

**Terminal schema:**
```typescript
// packages/shared/src/realtime.ts — 终态
export type ImageMeta = {
  source?: string
  timestamp?: string
  viewport?: { width: number; height: number }
}
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; url: string; alt?: string; meta?: ImageMeta }

export type TimelineMessage = {
  // ...existing fields...
  contentBlocks?: ContentBlock[]
}

// lib/blocks.ts — 终态
export type ImageBlock = {
  kind: "image"
  url: string
  alt?: string
  meta?: ImageMeta
}
export type Block = MarkdownBlock | ThinkingBlock | CardBlock | DiffBlock | ImageBlock
```

**"不做什么":**
- 不做 Playwright 浏览器自动化（P2 用 bridge script 或手动截图上传）
- 不做像素级视觉回归阻断（只建证据链，不卡合入）
- 不做 Skill 热更新（单独立项）
- 不做实时状态面板 / DevTools

---

## Task 1: P0 — dev:api Hot-Reload (AC1, AC2)

**Files:**
- Modify: `package.json:12` (root dev:api script)

**Step 1: 修改 dev:api 脚本**

将 root `package.json` 第 12 行：
```json
"dev:api": "bash scripts/mount-skills.sh && tsc -p packages/shared/tsconfig.json && tsc -p packages/api/tsconfig.json && node packages/api/dist/index.js",
```
改为：
```json
"dev:api": "bash scripts/mount-skills.sh && tsc -p packages/shared/tsconfig.json && tsx watch packages/api/src/index.ts",
```

逻辑：shared 仍然先编译（因为 API 的 tsconfig paths 指向 `../shared/dist/`），API 改用 tsx watch 直接运行 TS 源码。

**Step 2: 验证 dev 模式能启动**

Run: `pnpm run dev:api`
Expected: Fastify 正常启动，控制台输出 listening 日志。修改一个 API 文件后自动重启。
Ctrl+C 退出。

**Step 3: 验证 prod build 不受影响**

Run: `pnpm build`
Expected: tsc 编译成功，`packages/api/dist/` 产出正常。

**Step 4: Commit**

```bash
git add package.json
git commit -m "feat(F008): P0 dev:api hot-reload via tsx watch [黄仁勋/Opus-46 🐾]"
```

---

## Task 2: P1a — ContentBlock 类型 + TimelineMessage 扩展 (AC3, AC4)

**Files:**
- Modify: `packages/shared/src/realtime.ts:1-78`
- Modify: `packages/shared/src/index.ts` (确保 export)

**Step 1: 在 realtime.ts 添加 ContentBlock 类型**

在 `TimelineMessage` 定义之前（第 58 行附近）插入：

```typescript
export type ImageMeta = {
  source?: string
  timestamp?: string
  viewport?: { width: number; height: number }
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; url: string; alt?: string; meta?: ImageMeta }
```

**Step 2: 给 TimelineMessage 加 contentBlocks 字段**

在 `TimelineMessage` 类型里（`createdAt` 之前）加：
```typescript
contentBlocks?: ContentBlock[]
```

**Step 3: 确认 export**

`packages/shared/src/index.ts` 已经 `export * from "./realtime"`，ContentBlock 和 ImageMeta 会自动导出。确认即可。

**Step 4: 重新编译 shared**

Run: `tsc -p packages/shared/tsconfig.json`
Expected: 编译成功，无错误。

**Step 5: Commit**

```bash
git add packages/shared/
git commit -m "feat(F008): P1a ContentBlock 类型 + TimelineMessage.contentBlocks [黄仁勋/Opus-46 🐾]"
```

---

## Task 3: P1b — 前端 ImageBlock 类型 + 渲染组件 (AC5, AC7)

**Files:**
- Modify: `lib/blocks.ts:1-61` (加 ImageBlock 类型 + 更新 normalizeMessageToBlocks)
- Create: `components/chat/rich-blocks/image-block.tsx`
- Modify: `components/chat/block-renderer.tsx:1-33` (加 image case)

**Step 1: 在 lib/blocks.ts 添加 ImageBlock 类型**

在 `DiffBlock` 定义之后、`Block` union 之前（第 31-32 行）插入：

```typescript
export type ImageBlock = {
  kind: "image"
  url: string
  alt?: string
  meta?: { source?: string; timestamp?: string; viewport?: { width: number; height: number } }
}
```

更新 Block union：
```typescript
export type Block = MarkdownBlock | ThinkingBlock | CardBlock | DiffBlock | ImageBlock
```

**Step 2: 更新 normalizeMessageToBlocks**

在 `lib/blocks.ts` 的 `normalizeMessageToBlocks` 函数中，在 "Main content" 之后（第 58 行之后）插入：

```typescript
// 3. ContentBlocks → typed blocks (AC7)
if (message.contentBlocks) {
  for (const cb of message.contentBlocks) {
    if (cb.type === "image") {
      blocks.push({
        kind: "image",
        url: cb.url,
        alt: cb.alt,
        meta: cb.meta,
      })
    }
  }
}
```

**Step 3: 创建 ImageBlock 组件**

创建 `components/chat/rich-blocks/image-block.tsx`：

```tsx
"use client"

import { useState, useCallback } from "react"
import type { ImageBlock as ImageBlockType } from "@/lib/blocks"

export function ImageBlockComponent({ block }: { block: ImageBlockType }) {
  const [expanded, setExpanded] = useState(false)
  const toggle = useCallback(() => setExpanded((v) => !v), [])

  return (
    <>
      <figure className="my-2 max-w-full">
        <button type="button" onClick={toggle} className="cursor-zoom-in">
          <img
            src={block.url}
            alt={block.alt ?? ""}
            className="max-h-64 rounded-lg border border-zinc-700 object-contain"
          />
        </button>
        {block.alt && (
          <figcaption className="mt-1 text-xs text-zinc-500">{block.alt}</figcaption>
        )}
        {block.meta?.viewport && (
          <span className="text-[10px] text-zinc-600">
            {block.meta.viewport.width}×{block.meta.viewport.height}
          </span>
        )}
      </figure>

      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={toggle}
          onKeyDown={(e) => e.key === "Escape" && toggle()}
          role="button"
          tabIndex={0}
        >
          <img
            src={block.url}
            alt={block.alt ?? ""}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
          />
        </div>
      )}
    </>
  )
}
```

**Step 4: 更新 BlockRenderer**

在 `components/chat/block-renderer.tsx` 中：

1. 添加 import：
```typescript
import { ImageBlockComponent } from "./rich-blocks/image-block"
```

2. 在 switch 的 `case "diff":` 之后加：
```typescript
case "image":
  return <ImageBlockComponent key={index} block={block} />
```

**Step 5: 验证 typecheck**

Run: `pnpm typecheck`
Expected: 无类型错误。

**Step 6: Commit**

```bash
git add lib/blocks.ts components/chat/rich-blocks/image-block.tsx components/chat/block-renderer.tsx
git commit -m "feat(F008): P1b ImageBlock 渲染 + normalizeMessageToBlocks 扩展 [黄仁勋/Opus-46 🐾]"
```

---

## Task 4: P1c — 后端静态文件服务 (AC6)

**Files:**
- Modify: `packages/api/package.json` (加 @fastify/static 依赖)
- Modify: `packages/api/src/server.ts:199-203` (注册 static 插件)

**Step 1: 安装 @fastify/static**

Run: `pnpm --filter @multi-agent/api add @fastify/static`

**Step 2: 在 server.ts 注册 static 插件**

在 `packages/api/src/server.ts`，`await app.register(websocket)` 之后插入：

```typescript
import fastifyStatic from "@fastify/static"
import path from "node:path"

// ... 在 register websocket 之后：
const uploadsDir = path.resolve(__dirname, "../../../.runtime/uploads")
await app.register(fastifyStatic, {
  root: uploadsDir,
  prefix: "/uploads/",
  decorateReply: false,
})
```

注意：使用 `.runtime/uploads/` 目录（跟现有的 `.runtime/api.log` 在同一层级）。

**Step 3: 确保 uploads 目录存在**

在 static 注册之前加：
```typescript
import { mkdirSync } from "node:fs"
mkdirSync(uploadsDir, { recursive: true })
```

**Step 4: 验证静态服务**

Run: `pnpm run dev:api`
手动在 `.runtime/uploads/` 放一个测试图片，访问 `http://localhost:3141/uploads/test.png` 应返回图片。

**Step 5: Commit**

```bash
git add packages/api/
git commit -m "feat(F008): P1c @fastify/static 静态文件服务 /uploads/ [黄仁勋/Opus-46 🐾]"
```

---

## Task 5: P1.5a — createLogger 工具函数 + 全局 ErrorHandler (AC8, AC9)

**Files:**
- Create: `packages/api/src/lib/logger.ts`
- Modify: `packages/api/src/server.ts` (注册 errorHandler)

**Step 1: 创建 logger 工具函数**

创建 `packages/api/src/lib/logger.ts`：

```typescript
import type { FastifyBaseLogger } from "fastify"

let _rootLogger: FastifyBaseLogger | null = null

export function setRootLogger(logger: FastifyBaseLogger) {
  _rootLogger = logger
}

export function createLogger(scope: string): FastifyBaseLogger {
  if (!_rootLogger) {
    throw new Error("Root logger not initialized — call setRootLogger() first")
  }
  return _rootLogger.child({ scope })
}
```

**Step 2: 在 server.ts 初始化 root logger**

在 `createApiServer` 函数里，`const app = Fastify(...)` 之后：

```typescript
import { setRootLogger, createLogger } from "./lib/logger"

setRootLogger(app.log)
```

**Step 3: 注册全局 errorHandler**

在 `createApiServer` 的 plugin 注册区域之后：

```typescript
app.setErrorHandler((error, request, reply) => {
  app.log.error({ err: error, url: request.url, method: request.method }, "unhandled error")
  reply.status(error.statusCode ?? 500).send({ error: error.message })
})
```

**Step 4: 验证 typecheck**

Run: `pnpm --filter @multi-agent/api typecheck`
Expected: 无错误。

**Step 5: Commit**

```bash
git add packages/api/src/lib/logger.ts packages/api/src/server.ts
git commit -m "feat(F008): P1.5a createLogger + 全局 errorHandler [黄仁勋/Opus-46 🐾]"
```

---

## Task 6: P1.5b — WebSocket 日志 (AC10)

**Files:**
- Modify: `packages/api/src/routes/ws.ts:35-110`

**Step 1: 给 ws.ts 加日志**

在 `registerWsRoute` 函数顶部：
```typescript
import { createLogger } from "../lib/logger"
const log = createLogger("ws")
```

在 socket 连接时（添加到 sockets 后）：
```typescript
log.info({ total: sockets.size }, "client connected")
```

在 socket close 时：
```typescript
log.info({ total: sockets.size }, "client disconnected")
```

在消息处理时（parse 之后）：
```typescript
log.debug({ type: event.type }, "client event received")
```

**Step 2: 验证日志输出**

Run: `pnpm run dev:api`，打开前端连接 WebSocket，观察 Pino JSON 日志里出现 `"scope":"ws"` 的条目。

**Step 3: Commit**

```bash
git add packages/api/src/routes/ws.ts
git commit -m "feat(F008): P1.5b WebSocket 连接/事件日志 [黄仁勋/Opus-46 🐾]"
```

---

## Task 7: P1.5c — Agent 调度日志 + 静默 catch 修复 (AC11, AC12)

**Files:**
- Modify: `packages/api/src/services/message-service.ts` (关键路径日志 + catch 块)

**Step 1: 在 MessageService 构造函数中初始化 logger**

在 `MessageService` class 顶部加字段：
```typescript
import { createLogger } from "../lib/logger"

export class MessageService {
  private readonly log = createLogger("message-service")
  // ...existing fields...
```

**Step 2: 关键路径加日志**

在以下位置加 `this.log.info()`：
- `handleSendMessage` 入口（约 L619）：`this.log.info({ provider, content: content.slice(0, 80) }, "user message received")`
- `runThreadTurn` 入口（约 L736）：`this.log.info({ threadId, agentId, provider }, "turn started")`
- `runThreadTurn` 结束（正常完成处）：`this.log.info({ threadId, agentId }, "turn completed")`
- `flushDispatchQueue` 入口（约 L1306）：`this.log.info({ sessionGroupId, queueSize }, "flushing dispatch queue")`
- `handleAgentPublicMessage` 入口（约 L537）：`this.log.info({ from, to }, "agent public message")`

**Step 3: 修复静默 catch 块**

遍历 `message-service.ts` 中所有 catch 块，将空 catch 或只有 console.error 的改为：
```typescript
catch (err) {
  this.log.error({ err }, "描述性消息")
  // ...existing logic if any...
}
```

重点：`runThreadTurn` 的 catch（约 L1262）和 `handleParallelThink` 的 catch（约 L1907）。

**Step 4: 对其他 service 文件做同样处理**

需要检查并修复的文件（按影响面排序）：
- `packages/api/src/services/session-service.ts`
- `packages/api/src/orchestrator/dispatch-orchestrator.ts`
- `packages/api/src/runtime/cli-orchestrator.ts`

每个文件：顶部 `import { createLogger }` + 替换静默 catch。

**Step 5: 验证 typecheck**

Run: `pnpm --filter @multi-agent/api typecheck`
Expected: 无错误。

**Step 6: Commit**

```bash
git add packages/api/src/
git commit -m "feat(F008): P1.5c agent 调度日志 + 静默 catch 修复 [黄仁勋/Opus-46 🐾]"
```

---

## Task 8: P2a — 图片上传端点 (AC13, AC15)

**Files:**
- Modify: `packages/api/package.json` (加 @fastify/multipart)
- Create: `packages/api/src/routes/uploads.ts`
- Modify: `packages/api/src/server.ts` (注册 multipart 插件 + upload route)

**Step 1: 安装 @fastify/multipart**

Run: `pnpm --filter @multi-agent/api add @fastify/multipart`

**Step 2: 在 server.ts 注册 multipart 插件**

```typescript
import multipart from "@fastify/multipart"

await app.register(multipart, {
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
})
```

**Step 3: 创建 upload route**

创建 `packages/api/src/routes/uploads.ts`：

```typescript
import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { pipeline } from "node:stream/promises"
import path from "node:path"
import { createLogger } from "../lib/logger"

const log = createLogger("uploads")
const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"])

export function registerUploadRoutes(app: FastifyInstance, uploadsDir: string) {
  app.post("/api/uploads", async (request, reply) => {
    const file = await request.file()
    if (!file) {
      return reply.status(400).send({ error: "no file provided" })
    }
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      return reply.status(400).send({ error: `unsupported mime type: ${file.mimetype}` })
    }

    const ext = path.extname(file.filename) || ".png"
    const name = `${randomUUID()}${ext}`
    const dest = path.join(uploadsDir, name)

    await pipeline(file.file, createWriteStream(dest))
    log.info({ name, mime: file.mimetype, size: file.file.bytesRead }, "file uploaded")

    return { url: `/uploads/${name}` }
  })
}
```

**Step 4: 在 server.ts 注册 upload route**

在 route 注册区域加：
```typescript
registerUploadRoutes(app, uploadsDir)
```

**Step 5: 写测试**

创建 `packages/api/src/routes/uploads.test.ts`：

```typescript
import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"

// 测试 ALLOWED_MIMES 和文件名生成逻辑
// 集成测试需要启动 Fastify 实例，用 app.inject() 模拟请求
```

**Step 6: 验证**

Run: `curl -F "file=@test.png" http://localhost:3141/api/uploads`
Expected: `{ "url": "/uploads/<uuid>.png" }`

**Step 7: Commit**

```bash
git add packages/api/
git commit -m "feat(F008): P2a 图片上传端点 POST /api/uploads [黄仁勋/Opus-46 🐾]"
```

---

## Task 9: P2b — 前端 ChatInput 图片上传 (AC14, AC16)

**Files:**
- Modify: `components/chat/composer.tsx:70-277`
- Modify: `lib/store.ts` 或 `lib/realtime.ts`（send 函数扩展支持 attachments）

**Step 1: Composer 加文件上传按钮 + 粘贴处理**

在 `components/chat/composer.tsx` 中：

1. 加 hidden file input：
```tsx
<input
  ref={fileInputRef}
  type="file"
  accept="image/*"
  className="hidden"
  onChange={handleFileSelect}
/>
```

2. 在 textarea 旁边加上传按钮（用 lucide-react 的 ImagePlus 图标）

3. 加 onPaste handler 到 textarea，检测 clipboardData.files

**Step 2: 上传逻辑**

```typescript
async function uploadFile(file: File): Promise<string> {
  const form = new FormData()
  form.append("file", file)
  const res = await fetch("/api/uploads", { method: "POST", body: form })
  const data = await res.json()
  return data.url
}
```

**Step 3: 发送消息时附带 contentBlocks**

扩展 `send_message` 的 payload，增加可选 `contentBlocks` 字段。需要：
1. 修改 `RealtimeClientEvent` 的 `send_message` payload
2. 后端 `handleSendMessage` 处理 contentBlocks
3. 创建的 `TimelineMessage` 包含 contentBlocks

**Step 4: 验证端到端**

1. 打开前端，在 Composer 里粘贴/上传一张图片
2. 发送消息
3. timeline 中应显示图片（ImageBlock 渲染）
4. 点击图片弹出 lightbox 放大

**Step 5: Commit**

```bash
git add components/chat/composer.tsx lib/ packages/shared/
git commit -m "feat(F008): P2b ChatInput 图片上传 + contentBlocks 端到端 [黄仁勋/Opus-46 🐾]"
```

---

## 实施检查项

| 检查项 | 验证方式 | 时机 |
|--------|---------|------|
| tsx watch dev/prod 边界 | `pnpm build` + `node dist/index.js` 仍正常 | Task 1 完成后 |
| shared 重编译 | `tsc -p packages/shared/tsconfig.json` 无错 | Task 2 完成后 |
| ImageBlock lightbox 无障碍 | keyboard escape 关闭 + aria 属性 | Task 3 完成后 |
| uploads 目录 .gitignore | `.runtime/` 已在 .gitignore | Task 4 完成后 |
| Pino JSON 格式未被破坏 | dev:api 日志仍可 pipe 给 pino-pretty | Task 5 完成后 |
| 静默 catch 覆盖率 | grep 剩余空 catch 数量 ≤ 20% | Task 7 完成后 |
| multipart 大文件拒绝 | curl 上传 >10MB 文件，应返回 413 | Task 8 完成后 |

---

## 依赖关系

```
Task 1 (P0 hot-reload)     → 独立，最先做
Task 2 (P1a types)         → 独立
Task 3 (P1b 前端渲染)      → 依赖 Task 2（需要 ContentBlock 类型）
Task 4 (P1c 静态服务)      → 独立
Task 5 (P1.5a logger)      → 独立
Task 6 (P1.5b ws 日志)     → 依赖 Task 5
Task 7 (P1.5c agent 日志)  → 依赖 Task 5
Task 8 (P2a 上传端点)      → 依赖 Task 4 + Task 5
Task 9 (P2b 前端上传)      → 依赖 Task 3 + Task 8
```

**并行策略：**
- 第一批（并行）：Task 1, Task 2, Task 4, Task 5
- 第二批（并行）：Task 3, Task 6, Task 7
- 第三批：Task 8
- 第四批：Task 9
