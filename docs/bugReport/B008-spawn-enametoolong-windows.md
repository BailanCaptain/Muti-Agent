---
id: B008
title: spawn ENAMETOOLONG — Windows 命令行超长导致 Claude/Codex agent 无法启动
related: F005
reporter: 黄仁勋（自诊断）
created: 2026-04-11
---

# B008 — spawn ENAMETOOLONG — Windows 命令行超长导致 agent 无法启动

## 1. 报告人 / 发现方式

黄仁勋（Claude runtime，自诊断）。  
发现时间：2026-04-11 13:54:18 会话中，黄仁勋（Claude runtime）和范德彪（Codex runtime）同时上报 `Error: spawn ENAMETOOLONG`，桂芬（Gemini runtime）正常运行，三方表现不一致，触发排查。

## 2. 复现步骤

**期望行为**：随对话历史积累，三个 agent runtime（Claude、Codex、Gemini）均可正常启动子进程并流式输出。

**实际行为**：
1. 对话历史积累到一定轮次后，Claude runtime 和 Codex runtime 报 `Error: spawn ENAMETOOLONG`，子进程启动失败，agent 无响应
2. Gemini runtime 同等历史长度下正常运行，无报错
3. 错误在单轮短消息时不出现，随历史增长必然触发

## 3. 根因分析

**核心原因：`assemblePrompt` 组装的 prompt 内容随历史积累最大可达 90K 字符，超过 Windows `CreateProcess` 对命令行参数总长度 32,767 字符的上限，Node.js `spawn()` 在 OS 层被拒绝执行，抛出 `ENAMETOOLONG`。**

**POLICY_FULL 下的 prompt 规模上限**：
- 共享历史：30 条 × 2000 字符 = 60,000 字符
- 自身历史：15 条 × 2000 字符 = 30,000 字符
- 合计：最大约 90,000 字符，远超 Windows 32,767 字符上限

**为何 Claude 和 Codex 报错，Gemini 不报错**：

- `claude-runtime.ts`：`shell: false`，Node.js 成功解析到 `cli.js` 路径，将 `prompt` 和 `systemPrompt` 作为命令行参数（`--prompt`、`--system-prompt`）直接传给 `spawn()` → 命令行总长超限 → `ENAMETOOLONG`
- `codex-runtime.ts`：`shell: false`，Node.js 成功解析到 `codex.js` 路径，将 `wrapPromptWithInstructions(systemPrompt, prompt)` 合并后作为单个位置参数传给 `spawn()` → 命令行总长超限 → `ENAMETOOLONG`
- `gemini-runtime.ts`：`resolveNodeScript` 查找 `dist/index.js` 或 `bundle/gemini.js`，实际安装路径不在这些位置，解析失败，降级到 `shell: true`；Windows shell 模式下 `cmd.exe` 对参数长度的处理方式不同，不抛出 `ENAMETOOLONG` → 表面正常（实为"因祸得福"的偶然免疫，非设计正确）

## 4. 修复方案

**实测验证**：三个 CLI 全部支持从 stdin 读取 prompt：
- Claude CLI：输入 `--stdin` 参数后，输出 "stdin works" 确认支持
- Codex CLI：自动检测 stdin，启动时显式打印 "Reading prompt from stdin..."，确认支持
- Gemini CLI：同样支持 stdin 模式

**接口变更**：在 `RuntimeCommand` 接口新增 `stdinContent?: string` 字段。

**各 runtime 改动**：各 runtime 的 `buildCommand` 方法将大 prompt 写入 `stdinContent`，从 `args` 数组中移除对应参数，命令行参数仅保留短标志和路径。

**base-runtime.ts 改动**：`runStream` 方法检测 `command.stdinContent`：
- 若存在，则 `stdio: ["pipe", "pipe", "pipe"]`，子进程启动后执行 `child.stdin.end(stdinContent)`，通过管道注入 prompt
- 若不存在，沿用原有 `stdio` 配置，行为不变

## 5. 验证方式

- **单测（黑盒）**：mock `spawn`，验证当 prompt 长度超过 30,000 字符时，`args` 中不含 prompt 内容，`stdinContent` 字段有值且内容匹配
- **单测（base-runtime）**：验证 `stdinContent` 存在时，`child.stdin.end` 被调用且参数正确
- **集成验证**：在 Windows 环境构造 90K 字符历史，三个 runtime 均可正常启动，无 `ENAMETOOLONG` 报错
- **回归**：Gemini runtime 最终也改为 stdin 注入，消除"shell 降级偶然免疫"的隐患，行为与 Claude/Codex 对齐
