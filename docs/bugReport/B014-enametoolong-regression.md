---
id: B014
title: spawn ENAMETOOLONG 复发 — F012 AC-26 撤回 B008 修复导致三 agent 全挂
related: B008, F012
reporter: 小孙（村长）
created: 2026-04-16
status: fixed
---

# B014 — spawn ENAMETOOLONG 复发 — 三 agent 全挂

## 1. 报告人 / 发现方式

小孙（村长）在 2026-04-15 下午使用 @黄仁勋 / @桂芬 / @范德彪 时发现三家 agent 全部无响应或返回空气泡。黄仁勋（Claude runtime）介入分析，在 SQLite messages 表中发现 `Error: spawn ENAMETOOLONG` 错误内容。

## 2. 复现步骤

**前置条件**：dev 分支合入 F012（commit `87e7436`），其中包含 `cf27d68 refactor(F012): 三CLI stdin→参数传prompt (AC-26)`。

**期望行为**：@mention 任意 agent → 正常流式响应。

**实际行为**：
1. 对话历史积累数十轮后，三家 agent 全部报 `Error: spawn ENAMETOOLONG`
2. 新建会话也可能触发（取决于 system prompt + history envelope 的总长度）
3. 在 DB 中留下 `[empty response]`（16 字节）或 `Error: spawn ENAMETOOLONG`（25 字节）记录

## 3. 根因分析

**直接原因**：`cf27d68` 将三个 runtime 的 prompt 从 `stdinContent`（管道传输）改回 argv（命令行参数 `-p` / `--` 传输），导致 assembled prompt 超过 Windows `CreateProcess` 的 32,767 字符上限。

**根因回溯**：这是 **B008 的精确复发**。B008 于 2026-04-11 诊断并修复了完全相同的问题（commit `9fe0adf`）。F012 的 AC-26 在 4 天后（2026-04-15）以"参照 clowder-ai 实现"为由撤回了 B008 的修复。

**为什么 AC-26 的 rationale 不成立**：
- clowder-ai 大概率运行在 Linux/macOS（ARG_MAX 128KB+），不受 Windows 32K 限制
- 我们的 `POLICY_FULL` 设计上最大注入 ~90KB 历史（self 15×2K + shared 30×2K），远超 Windows 限制
- AC-26 没有回查 B008 bug 报告，没有验证 B008 的根因是否仍成立

## 4. DB 中的事故记录

session group `662cb89d`（黄仁勋线程）+ `ecbb44af`（桂芬线程）：
```
07:37:42  黄仁勋  [empty response]
07:37:59  黄仁勋  [empty response]
07:38:37  黄仁勋  Error: spawn ENAMETOOLONG
07:39:03  黄仁勋  Error: spawn ENAMETOOLONG
07:39:07  黄仁勋  Error: spawn ENAMETOOLONG
07:39:13  桂芬    Error: spawn ENAMETOOLONG
```

## 5. 修复方案

**撤回 cf27d68 的 3 文件改动**（6 行变更），恢复 B008 的 stdinContent 路径：
- `claude-runtime.ts`：移除 `args.push("-p", input.prompt)`，恢复 `stdinContent: input.prompt`
- `codex-runtime.ts`：移除 `"--", prompt` 位置参数，恢复 `stdinContent: prompt`
- `gemini-runtime.ts`：移除 `args.push("-p", prompt)`，恢复 `stdinContent: prompt`

base-runtime.ts 的 stdinContent 分发逻辑（line 250-254）从未被 cf27d68 修改，无需改动。
base-runtime.test.ts 的两条 stdinContent 测试从未被删除，撤回后直接复用。

## 6. 验证

- `npx tsx --test src/runtime/base-runtime.test.ts`：13/13 全绿
- `npx tsc --noEmit`：零错误
- F012 spec AC-26 已标记 REVOKED，Timeline 已补记

## 7. 流程反思 → Lesson Learned

见 `docs/lessons/lessons-learned.md` → LL-023。
