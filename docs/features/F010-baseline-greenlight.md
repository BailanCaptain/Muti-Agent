---
id: F010
title: 基线回绿 + P0 止血 — typecheck/test 全绿 + 崩服务级 bug 修复
status: completed
owner: 黄仁勋
created: 2026-04-14
---

# F010 — 基线回绿 + P0 止血

**Created**: 2026-04-14

## Why

三方独立审计（黄仁勋 / 范德彪 / 桂芬）发现项目处于**工程失稳状态**：

- `pnpm typecheck` 7 处断裂（session-repo / logger / decision-mgr / uploads / embedding / context-assembler.test / approval-manager.test）
- `pnpm test` 493 条中 2 条红（phase1-header 约束缺失 + approval.resolved 契约滞后）
- 文档状态双写漂移（frontmatter 与正文 `**Status**:` 不一致）
- 4 个 P0 级 bug（WebSocket 崩服务、Promise 吞错误、渲染期 setState、Zustand 不响应式）

> 后面所有 Feature 的验收都依赖"基线是绿的"这个前提。不修这个，改了代码都不知道是改好了还是改坏了。

### 讨论来源

- 全面排查讨论：三方独立审计 → 综合报告
- 范德彪验证记录：`pnpm typecheck` 失败、`pnpm test` 491/493 绿

## Acceptance Criteria

### Phase 1：typecheck 全绿（阻塞一切）
- [x] AC-01: `session-repository.ts` 类型断裂修复
- [x] AC-02: `logger.ts` 类型断裂修复（pino 类型声明）
- [x] AC-03: `decision-manager.ts:118` verdict 类型从 string 收紧为联合类型
- [x] AC-04: `uploads.ts:29` request.file() 类型声明补全
- [x] AC-05: `embedding-service.ts:57` @huggingface/transformers 类型声明补全
- [x] AC-06: `context-assembler.test.ts` 类型断裂修复
- [x] AC-07: `approval-manager.test.ts` 类型断裂修复
- [x] AC-08: `package.json` 补声明依赖 pino + @huggingface/transformers
- [x] AC-09: `pnpm typecheck` 全绿（0 errors）

### Phase 2：测试全绿
- [x] AC-10: `phase1-header.ts` 补回"不要加载全文"约束，或更新测试断言对齐当前行为
- [x] AC-11: `approval-manager.test.ts:51` approval.resolved 测试对齐共享契约
- [x] AC-12: `pnpm test` 全绿（493/493）

### Phase 3：文档状态单点化
- [x] AC-13: 所有 `docs/features/*.md` 和 `docs/bugs/*.md` 中正文 `**Status**: xxx` 行删除，只保留 frontmatter `status:` 字段
- [x] AC-14: frontmatter status 值与实际代码状态对齐（如 F002 应为 done、B005 应为 fixed）

### Phase 4：P0 Bug 修复
- [x] AC-15: `ws.ts:78` JSON.parse 加 try-catch，畸形消息不再崩服务（BUG-1）
- [x] AC-16: `message-service.ts` 三处 void promise（:457, :1211, :1789）加 .catch + logger.error（BUG-2）
- [x] AC-17: `cli-output-block.tsx:293-295` 渲染期 setState 移入 useEffect（BUG-3）
- [x] AC-18: `execution-bar.tsx:38-40` getState() 改成 Zustand selector，approval 状态响应式更新（BUG-4）

### 门禁
- [x] AC-19: 全部完成后 `pnpm typecheck && pnpm test` 一次性通过

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| phase1-header 约束缺失 | A: 补回约束 / B: 更新测试 | 视实际行为定 | 需确认"不要加载全文"是有意移除还是遗漏 |
| 文档状态真相源 | A: frontmatter / B: 正文 / C: 双写 | A: frontmatter 唯一 | 双写必然漂移，CI 脚本只校验 frontmatter |
| approval.resolved 修复策略 | A: 改代码 / B: 改测试 | B: 改测试 | 范德彪确认是测试没跟上共享协议变更，不是代码错 |

## 验证命令

```bash
# 全量验证
pnpm typecheck && pnpm test

# 文档状态校验（无正文 Status 双写）
grep -rn '^\*\*Status\*\*:' docs/features/ docs/bugs/ && echo "FAIL: 正文仍有 Status 双写" || echo "PASS"
```

## Bug 详情

### BUG-1: WebSocket JSON.parse 无保护
- **文件**: `packages/api/src/routes/ws.ts:78`
- **现象**: `JSON.parse(raw.toString())` 无 try-catch，畸形 JSON 直接崩 handler
- **修复**: 加 try-catch，catch 内 logger.warn + socket.send 错误响应

### BUG-2: Fire-and-forget Promise 吞错误
- **文件**: `packages/api/src/services/message-service.ts:457, 1211, 1789`
- **现象**: `void this.handleSendMessage(...)` 等三处，reject 后无日志、agent 卡在 working
- **修复**: 每处加 `.catch(err => logger.error({ err }, 'background task failed'))`

### BUG-3: 渲染期 setState
- **文件**: `components/chat/rich-blocks/cli-output-block.tsx:293-295`
- **现象**: 函数组件 body 中直接调 `setToolsExpanded(true)`，React 反模式
- **修复**: 移入 `useEffect(() => { if (isStreaming && !toolsExpanded) setToolsExpanded(true) }, [isStreaming])`

### BUG-4: Zustand getState() 不响应式
- **文件**: `components/chat/execution-bar.tsx:38-40`
- **现象**: `useApprovalStore.getState().pending.some(...)` 是一次性快照读取，不会触发 re-render
- **修复**: 改为 `const pending = useApprovalStore(s => s.pending)` selector 订阅

## Timeline

| 日期 | 事件 | 说明 |
|------|------|------|
| 2026-04-14 | 三方审计完成 | 15 个 bug + 4 个架构隐忧 |
| 2026-04-14 | F010 立项 | 基线回绿 + P0 止血，阻塞 F011/F012/F013 |
| 2026-04-14 | 19/19 AC 完成 | typecheck 0 err + 493/493 test + 文档单点化 + P0 止血 |
| 2026-04-14 | 桂芬愿景守护 PASS | 无 scope creep，前端修复合理 |
| 2026-04-14 | 桂芬 code review PASS | P2 defer to F012，无阻塞项 |
| 2026-04-14 | Merged to dev | squash merge，1 commit |

## Links

- 全面排查讨论综合报告（对话内）
- Related: F009 (前序 feature，性能优化已合入)

## Evolution

- **Blocks**: F011（后端加固）、F012（前端加固）、F013（CI 门禁）
- **Trigger**: 三方独立审计发现工程失稳
