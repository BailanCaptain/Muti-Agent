---
B-ID: B018
title: API CORS_ORIGIN 硬编码 :3000，worktree L1 preview 端口全被拒
status: open
related: F024 (Worktree 愿景验收基础设施 — L1 preview)
reporter: 小孙（worktree L1 preview @ :3200 访问转圈圈进不去）
created: 2026-04-20
severity: P1
---

# B018 — API CORS_ORIGIN 硬编码 :3000 + worktree L1 preview 端口被拒

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | 小孙打开 F022 worktree L1 preview `http://localhost:3200`，页面永久转圈圈，bootstrap 不 resolve。 |
| 2 | **证据** | (a) `curl http://localhost:8787/api/bootstrap` **200 OK**（API 本身健康）(b) `curl -H "Origin: http://localhost:3200" -X OPTIONS http://localhost:8787/api/bootstrap` → **400 Invalid Preflight Request**，响应头 `access-control-allow-origin: http://localhost:3000` (c) 前端 `thread-store.ts:272` `fetchJson` 直连 `NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"`，浏览器预检被拒 → fetch reject → bootstrap hang |
| 3 | **假设** | 根因 = `packages/api/src/config.ts:6` `corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000"` 只接受单 string，`@fastify/cors` 原样传入后白名单只有一项 :3000。任何 L1 preview（F024 基础设施起在 :3200/:3201…）都不在白名单内 → CORS 预检拒绝。 |
| 4 | **诊断策略** | 已完成：直连 API 200 正常 + CORS preflight 实测 400 + 对照前端 fetchJson baseUrl 默认走绝对地址（非相对路径）→ 链路 3 点全部闭环。 |
| 5 | **用户可见修正** | 修复后小孙打开 `:3200` / `:3201` / 任意 worktree L1 preview 都能正常加载，不再转圈；生产部署（非 localhost）严格白名单仍生效。 |
| 6 | **复现验收** | (a) 单测：`parseCorsOrigin("localhost-any")` 返回 RegExp `/^http:\/\/localhost:\d+$/`，`.test("http://localhost:3200")` === true，`.test("https://evil.example")` === false (b) 单测：`parseCorsOrigin("http://a.com,http://b.com")` 返回 `["http://a.com","http://b.com"]` (c) 单测：`parseCorsOrigin(undefined)` 返回默认值（dev 通配 localhost）(d) 集成：`curl -H "Origin: http://localhost:3200" -X OPTIONS /api/bootstrap` → **204 + access-control-allow-origin: http://localhost:3200** |

## 修复方案

**设计**：`CORS_ORIGIN` 环境变量支持三种输入：

1. `"localhost-any"`（dev 默认）→ RegExp `/^http:\/\/localhost:\d+$/`，通配任意 localhost 端口
2. `"a.com,b.com"`（逗号分隔）→ `string[]` 严格白名单（生产部署）
3. 单 string（兼容旧）→ 保持 `"http://localhost:3000"` 行为

**改动点（预计 < 30 行 + 测试）**：
- `packages/api/src/config.ts` — 新增 `parseCorsOrigin(raw: string | undefined)` util
- `packages/api/src/server.ts:54` — `corsOrigin` 类型从 `string` 扩到 `string | RegExp | (string|RegExp)[]`
- 默认值由 `"http://localhost:3000"` 改为 `"localhost-any"`（dev 默认放宽）
- `.env.example` / `.env` 文档说明

**TDD 节奏**：
1. Red：`parseCorsOrigin.test.ts` — 4 条用例（localhost-any / 逗号分隔 / 单 string / undefined 默认）
2. Green：实现 `parseCorsOrigin`
3. Refactor：接入 server.ts，tsc/biome 全绿

## 引入时间线

- `config.ts:corsOrigin` 硬编码 :3000：项目初始引入，长期无人触发（因为主 dev 也跑在 :3000）
- F024（2f2e80f, 2026-04-20）引入 L1 preview 在 :3200 起 → 首次暴露 CORS 白名单硬编码缺口

## 非目标（Out of Scope）

- 不改前端 fetchJson baseUrl 策略（不引入 Next rewrites 代理，保持直连）
- 不改 F024 L1 preview 端口配置
- 不处理生产部署的 CORS 策略（沿用严格白名单，只扩输入格式）

## Links

- F024 worktree 愿景验收基础设施：`docs/features/F024-worktree-vision-acceptance.md`
- F022 Phase 3.5 验收：不依赖本 bug 修复（可走 :3000 dev 验收）
