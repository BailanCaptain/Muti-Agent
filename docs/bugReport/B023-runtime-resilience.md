---
id: B023
title: Runtime 韧性 — content 覆盖丢失 + codex session_id 8 周未捕获 + stall 阈值过严
status: open
related: B009, B010, B011, B017, F018, F021
created: 2026-05-08
---

# B023 — Runtime 韧性三合一修复

**症状族**：跟 B009 / B010 / B011 / B017 同一域（runtime 异常处理 + session 续推），但 R-105 实测中暴露三个互不相干的新问题，合并到一份 PR 修复。

**Created**: 2026-05-08
**Author**: 黄仁勋（Claude）
**触发**: 小孙报「仁勋运行到一半为什么会停下来 + 德彪也出现了同样症状 + agent 经常运行中报 stall 错前端内容全部消失」三个独立现象。R-105（worktree-F-026）实证追溯发现三件不相干的事。

---

## 1. 报告人 + 触发上下文

小孙 2026-05-08 报：

1. R-105 房间黄仁勋"先修"那条消息只写到一半就断了
2. 范德彪同房间最新一次 review 信也半截没派 [Call:] 结论
3. agent 经常运行中突然报 "Error: Agent 进程看起来已卡住（CPU 空转，无新输出 ≥ 300 秒）"，前端已经流出来的内容全部消失

调研发现三件事根因互不相干，合并到一个 PR 修复。

---

## 2. Bug 现象（三个独立症状）

### 症状 A：catch 路径覆盖流式内容

agent 流式写入消息到一半，runtime 抛 stall / inactivity / fast-fail / 任意 reject → message-service.ts:2194 catch (error) 用 `Error: ${message}` 文案**整个覆盖**已经流式累积的 content → 前端看到内容瞬间消失。

### 症状 B：codex 8 周从未成功 resume

codex CLI 第一帧 stdout emit `{type:"session_meta", payload:{id:"019e..."}}`，但 base-runtime.ts:findSessionId 只匹配 `session_id` / `sessionId` 字段名，**不识别 codex 的 `payload.id` 格式** → threads.native_session_id 永远是空字符串 → codex-runtime.ts:50-52 三元判断永远走 `else` 分支 → 每次 codex turn 都 fresh 起，从未走过 `codex exec resume`。

设计意图（codex-runtime.ts 第一版 commit `fbaf7f4` 2026-03-15）就是要 resume，**但配套的 stdout 解析代码从来没适配 codex 的 session_meta 格式**。

### 症状 C：silent 长 thinking turn 5min 被双路径误杀

5 分钟 idle-silent 被杀的原因实际有**两条路径**（review 修订）：

1. **`livenessStallWarningMs` 旧默认值 180s（3min）**：probe 检测到 idle-silent 即 fast-kill。代码默认值，无 env 设置。
2. **`inactivityTimeoutMs` 5min**（`.env:9` 实际配置 `MULTI_AGENT_INACTIVITY_TIMEOUT_MS=300000`）：5min 内 stdout 不动就 timeout reject — 即使 stall 阈值改大到 20min 仍会先被它杀。

Codex 偶发"做事中间 5 分钟无 stdout"被这两条路径任一击中 → 强制 kill。Gemini 429 retry 循环偶发同样误杀。Claude 因 thinking_delta 持续 stdout 不受影响。

> 历史本节曾误写"env 当前设 MULTI_AGENT_LIVENESS_STALL_WARNING_MS=300000"。实测 `.env` 无此条；真正的 5min 绞杀来自 `MULTI_AGENT_INACTIVITY_TIMEOUT_MS=300000` + 老默认 stall=180s 双重夹击。修复方案需同时改默认 stall 阈值 + 让 idle-silent 不被 inactivityTimeoutMs 主导。

---

## 3. DB 证据（决定性，全部 R-105 实测）

### 症状 A 现场（范德彪 stall 后内容消失）

```
DB: messages WHERE id='范德彪 02:08:06 final 那条'
content  = 97 字 ("Error: Agent 进程看起来已卡住（CPU 空转，无新输出 ≥ 300 秒...）")
thinking = 1356 字  ← 思考保留了
→ content 被无脑覆盖，前端看不见已经流式累积的实际内容
```

代码路径：`message-service.ts:2194`
```typescript
this.sessions.overwriteMessage(assistant.id, {
  content: `Error: ${message}`,   // ← 整个覆盖，不 append
  thinking,                       // ← 这个保留
  toolEvents: toolEventsJson,
  contentBlocks: ...,
})
```

### 症状 B 现场（codex session_id 全空 + 老对话碎片化）

```
DB: SELECT alias, provider, native_session_id FROM threads
桂芬 (gemini)：部分行 36 字 UUID（B017 防御正确触发清空 + F021 P6 seal 主动清空 = 设计行为）
黄仁勋 (claude)：部分行 36 字 UUID（同上）
范德彪 (codex)：所有行均为空字符串 ← 从未捕获过
```

```
codex stdout 实际格式（实测 ~/.codex/sessions/2026/03/11/rollout-*.jsonl 第一帧）：
{"timestamp":"...","type":"session_meta","payload":{"id":"019cdd4f-...","cli_version":"0.114.0",...}}
                                          ↑ 字段名是 payload.id，不是 session_id
```

```
base-runtime.ts:648-680 findSessionId:
- 只匹配 value.session_id / value.sessionId
- 递归子 value 时也只看这两个字段名
- codex 的 payload.id 永远不匹配 → 返回 null → onSession 永远不调
```

8 周累计影响（2026-03-15 codex-runtime 第一版 → 2026-05-08）：
- 数百次 codex turn 全部 fresh 起，无历史 conversation 复用
- ~/.codex/sessions/ 堆了几百个独立 session jsonl，互不连接
- F2 (codex race exit auto-retry) 没法直接做（依赖 native_session_id 续推）

### 症状 C 现场（codex stall 误杀）

```
DB: invocation 4a4ca8b3 (范德彪)
started        2026-05-08T02:08:06
last_activity  2026-05-08T02:16:01     ← 8 分钟时还有活
finished       2026-05-08T02:20:05     ← 5 分钟 silent 后被 kill
status         error
final.content  = 97 字 (= 症状 A 体现)
```

历史 stall 频次（实测）：
- 桂芬 (gemini)：6 次（5 inactivity + 1 stall，主要是 429 retry 循环）
- 范德彪 (codex)：1 次（5/8 02:08，本次）
- 黄仁勋 (claude)：近期 0 次（thinking_delta 持续 stdout 触发 recordStdoutActivity）

---

## 4. 根因分析

### 症状 A 根因

`message-service.ts:2161` catch (error) 路径无脑 `overwriteMessage(content: 'Error: ${message}')`，**没保留流式累积的 assistantContent**。这个 catch 路径覆盖：

- stall 触发（livenessStallWarningMs 超）
- inactivity timeout（inactivityTimeoutMs 超）
- fast-fail（classifyStderrChunk 命中已知致命错误）
- runtime reject（任何子进程 close 触发的 reject 路径）

任意 catch 触发 = 已流式内容全消失。

### 症状 B 根因

`base-runtime.ts:findSessionId` 是 **provider-agnostic** 通用函数，但实现只识别 Claude CLI 的 `{type:"system",session_id:"..."}` 格式。**codex CLI 的 `{type:"session_meta",payload:{id:"..."}}` 格式从第一天起就没适配**。

设计 → 实现脱节：
- codex-runtime.ts:50-52 第一版（2026-03-15 commit `fbaf7f4`）就有 resume 三元判断 → **设计意图要 resume**
- base-runtime.ts:findSessionId 解析路径只看了 Claude 格式 → **实现漏了 codex 适配**

8 周内 F003 / F004 / F018 等 feature 建立在"codex/gemini 永远 nativeSessionId=null"的现实上做兜底（SessionBootstrap 重组 history 喂回去），无人发现 **codex 的 nativeSessionId 应该有值才对**。

### 症状 C 根因

stall 阈值 300s 是 B010/B011 修过的值（原来更短，B011 时调到 300s 是为了不误杀 gemini 429 retry 循环）。但实测 codex 偶发 8min 工作 + 5min silent 仍命中阈值。

阈值 ≠ 设计 bug，是参数没跟上 LLM 真实行为：Opus 4.7 / GPT-5.4 thinking budget 高时 5min+ silent 是正常的，需要更宽容的兜底。

---

## 5. 修复方案

### 修复 A：catch 路径 append 不 overwrite（~10 行）

`message-service.ts:2194` 改造：

```typescript
// 改前：
this.sessions.overwriteMessage(assistant.id, {
  content: `Error: ${message}`,
  ...
})

// 改后：保留流式累积的 assistantContent，append 错误信息到末尾
const preservedContent = assistantContent || ""
const errorSeparator = preservedContent ? "\n\n---\n" : ""
this.sessions.overwriteMessage(assistant.id, {
  content: `${preservedContent}${errorSeparator}[runtime] Error: ${message}`,
  thinking,
  toolEvents: toolEventsJson,
  contentBlocks: ...,
})
```

效果：前端看到「流式累积的内容 + 末尾系统注释」，不再瞬间空白。

### 修复 B：base-runtime.findSessionId 加 codex session_meta 适配（~30 行）

两条路：

**路 1（推荐）**：base-runtime.findSessionId 加一条 codex 专用分支：

```typescript
// codex CLI: {type:"session_meta", payload:{id:"019e..."}}
if (value.type === "session_meta" &&
    value.payload && typeof value.payload === "object") {
  const payload = value.payload as Record<string, unknown>
  if (typeof payload.id === "string" && payload.id) {
    return payload.id
  }
}
```

**路 2（备选）**：codex-runtime 覆写 parseLine 钩子自己提取。但 base-runtime 现有 cli-orchestrator.ts:183 流程是统一从 findSessionId 拿，加分支更顺。

选**路 1**。

### 修复 C：stall 阈值 300s → 1200s（~5 行）

`base-runtime.ts:103` `DEFAULT_RUNTIME_LIFECYCLE.livenessStallWarningMs = 1200_000`（20min）+ env 默认值同步更新（如果 .env.example 有）。

不动 stall 检测逻辑（probe / busy-silent / idle-silent 都保留）。

---

## 6. 文档同步清单（user 强调"改的时候同步更新文档"）

### F018 timeline 追加修复记录

```markdown
| 2026-05-08 | **B023 修复**：发现 F018 落地后 codex 的 native_session_id 实际从未捕获（base-runtime.findSessionId 只匹配 session_id 字段，未适配 codex 的 session_meta.payload.id 格式）。F018 的 SessionBootstrap 兜底路径(AC3.5) 8 周来一直在掩盖此漏洞。本次修复后 codex 可正确捕获 session_id 并走原生 resume，SessionBootstrap 仅在真正"新 session"时启用。 |
```

F018 AC 区追加新 AC：

```markdown
- [ ] AC（B023 补）: codex turn 跑过一次后，thread.native_session_id 应有值（36 字 UUID），下一次 turn 走 codex exec resume 而非 fresh exec
```

### Lessons Learned 沉淀

新建/更新 `multi-agent-skills/refs/lessons-learned.md`（如果存在）：

> **LL-XXX：DB 字段为空 ≠ bug，必须先核所有写入路径**
>
> B023 调研中连续两次违反——只看 native_session_id 空就推测捕获漏，没核 message-service 的 4 条主动清空路径（B017 classifier × 3 + F021 P6 seal × 1）。教训：DB 状态分析 = 倒查所有 write call site 后才能下断言。
>
> 同型预防：
> - 新 CLI provider 接入必须实测 stdout 里 session_id 字段位置（不能假设跟 Claude 一样）
> - DB 字段调研必须 grep 所有 write 路径，逐条核对触发条件

### ROADMAP

- 「活跃 Bug」表加 B023 行
- F018 状态保持 done（不重开），但聚合文件 timeline 加补丁记录

---

## 7. Acceptance Criteria

- [ ] AC1：catch 路径触发后，DB messages.content 应包含原 streaming 内容 + `[runtime]` 错误信息追加（不是覆盖）
- [ ] AC2：base-runtime.findSessionId 输入 codex `{type:"session_meta",payload:{id:"019e..."}}` 返回 "019e..."
- [ ] AC3：base-runtime.findSessionId 输入 Claude 旧格式 `{type:"system",session_id:"abc"}` 仍返回 "abc"（不退化）
- [ ] AC4：跑两轮 codex turn，第二轮 stdout 起始处含 `--resume <id>` 参数 + DB threads.native_session_id 在两轮间相等（**实机验证，必须实测**）
- [ ] AC5：livenessStallWarningMs 默认值改为 1_200_000，1199s 无活动 + idle-silent 不触发 stall
- [ ] AC6：F018 文档 timeline 追加 B023 修复记录 + AC 补一条 codex resume 实测
- [ ] AC7：LL 沉淀 + ROADMAP 更新

---

## 8. Dependencies

- 无前置 feature 依赖
- 修完后 **解锁 B024**（孤儿 invocation reaper + auto-resume，仁勋"先修"那种场景）和 **B025**（codex race exit detection + auto-retry，德彪那种 #8479 场景）

---

## 9. Evolution

- **Evolved from**: 无（独立 bug 合集）
- **Blocks**: B024 (孤儿 reaper auto-resume) + B025 (codex race exit auto-retry) — 都依赖 B023 修好的 native_session_id 才能续推
- **Related**: B017 (假 session_id 污染防御，三家通治但 codex 部分实际未生效) / B011 (stall 误杀同源) / F018 (context-resume 架构，本次补回未生效部分) / F021 P6 (preventive seal，调研中验证其工作正常)

---

## 10. Timeline

| 日期 | 事件 |
|------|------|
| 2026-05-08 | Kickoff（基于 R-105 三个独立现象的实证调研） |
