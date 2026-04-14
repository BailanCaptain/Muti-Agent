---
id: F008
title: 开发基础设施 + 视觉证据链
status: spec
owner: 黄仁勋
created: 2026-04-14
---

# F008 — 开发基础设施 + 视觉证据链

**Status**: spec
**Created**: 2026-04-14

## Why

小孙原话（2026-04-14）：
> "我真的受够了我们的愿景守护完全没用 前端看不了图 后端我得重启服务手动验证 太难受了"
> "我们项目目前的代码仓 是不是完全没有日志？这让后期bug定位、feature开发是不是增添了很多不确定性？"

根因诊断（三人共识）：
1. **愿景守护全链条文本自证**——quality-gate / acceptance-guardian 无法"看见"前端，没有视觉证据通道
2. **前端无图片渲染能力**——BlockRenderer 只认 `markdown | thinking | card | diff`，协议层没把图片当一等内容
3. **后端无 hot-reload**——`dev:api` 用 `tsc + node dist/`，改代码要手动重启，验证循环太长
4. **应用层完全无日志**——49 个 catch 块静默吞错，WebSocket/Agent调度/DB 全黑盒，bug 定位靠猜

参考对照：clowder-ai 有完整图片管线（用户发图 + agent 截图 + lightbox 渲染 + 元信息），我们一个环节都没有。

## What

四层修复，让开发基础设施从"原始"升级到"可观测"：

1. **P0: dev:api hot-reload** — 后端改完秒生效（tsx watch）
2. **P1: 图片一等公民** — ContentBlock 加 image kind + ImageBlock 前端组件 + /uploads/ 静态服务
3. **P1.5: 结构化日志** — createLogger(scope) + 全局 errorHandler + 关键路径日志覆盖
4. **P2: 截图 + 用户发图** — 截图服务端点 + ChatInput 图片上传 + multipart 解析 + agent vision 通路

## Acceptance Criteria

### P0: Hot-Reload
- [ ] AC1: `pnpm run dev:api` 使用 `tsx watch` 直接运行 TS 源码，API 代码修改后自动重启
- [ ] AC2: prod 构建路径不受影响（`pnpm build` 仍走 tsc + node dist）

### P1: 图片一等公民
- [ ] AC3: shared 层新增 `ContentBlock` 类型，包含 `{ type: "image", url, alt?, meta? }` 其中 meta 含 source/timestamp/viewport
- [ ] AC4: `TimelineMessage` 新增可选 `contentBlocks?: ContentBlock[]` 字段
- [ ] AC5: 前端 `BlockRenderer` 支持 `image` kind，渲染 `ImageBlock` 组件（含 lightbox 放大）
- [ ] AC6: 后端通过 `@fastify/static` 在 `/uploads/` 路径提供静态文件服务
- [ ] AC7: `normalizeMessageToBlocks()` 能将 `contentBlocks` 中的 image 类型转换为前端 `ImageBlock`

### P1.5: 结构化日志
- [ ] AC8: 基于 Fastify 内置 Pino 封装 `createLogger(scope)` 工具函数
- [ ] AC9: Fastify 注册全局 `app.setErrorHandler()` 兜底处理
- [ ] AC10: WebSocket 连接/断开/消息收发有日志
- [ ] AC11: Agent 调度关键路径（runTurn / dispatch / A2A）有日志
- [ ] AC12: 现有静默 catch 块改为 `logger.error()` 记录（覆盖率 ≥ 80%）

### P2: 截图 + 用户发图
- [ ] AC13: 后端 `POST /api/preview/screenshot` 端点，接收 base64 图片，存入 `/uploads/`，返回 URL
- [ ] AC14: 前端 ChatInput 支持文件上传（点击 + 粘贴），客户端压缩后 multipart/form-data 上传
- [ ] AC15: 后端 multipart 解析 + 图片验证（MIME/大小）+ 存储
- [ ] AC16: 消息中的图片通过 contentBlocks 传递，前端正确渲染

## Dependencies

- 无外部依赖
- P1 依赖新增 `@fastify/static` 包
- P2 依赖 P1（需要 ImageBlock 渲染能力和 /uploads/ 服务）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 图片数据模型 | A: 塞进 ToolEvent / B: 走 ContentBlock | B: ContentBlock | ToolEvent 是日志语义，ContentBlock 是内容语义，不应混用（范德彪提出，全员同意） |
| 图片传输方式 | A: 纯 base64 / B: URL 引用 | 先兼容 base64 做 PoC，长期走 URL | 避免 WS 消息体膨胀（范德彪提出，全员同意） |
| 截图方案 | A: Playwright / B: Bridge script (clowder-ai 模式) | B: Bridge script | 纯前端方案，不需额外进程，Windows 兼容性无风险 |
| 愿景校验策略 | A: 自动阻断 / B: 人工肉眼 / C: 证据链不阻断 | C: 先建证据链 | 当前连"看图"都做不到，先把证据链跑通（黄仁勋提出，全员同意） |
| 截图元信息 | 只存图 / 带 meta | 带 meta（source, timestamp, viewport） | 否则验收证据不可复核（范德彪提出） |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-14 | Kickoff — 小孙提出痛点，三人并行+串行讨论收敛 |

## Links

- Discussion: `docs/discussions/2026-04-14-vision-guardian-infra.md`（本次讨论）
- Plan: 待创建
- Related: F006（UI/UX 重塑，本 Feature 补齐 F006 未覆盖的图片能力）

## Evolution

- **Evolved from**: F006（F006 做了 UI 渲染框架，但缺图片一等公民）
- **Blocks**: 无
- **Related**: F007（上下文压缩，日志基础设施对 F007 调试也有益）
