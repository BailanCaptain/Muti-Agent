---
B-ID: B017
title: --resume 失败回包的假 session_id 污染 thread.nativeSessionId 导致三家续接死循环
status: fixed
related: F004 (emptyAndAbnormal 条件), F018 (续接架构)
reporter: 小孙 (房间 8b43322b `@黄仁勋` 一直调不起来)
created: 2026-04-18
fixed: 2026-04-19
severity: P0
---

# B017 — --resume 失败回包假 session_id 污染 nativeSessionId 导致续接死循环

## 诊断胶囊(Phase 1 工作模板)

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | 用户在房间 `8b43322b` `@黄仁勋` 多次失败,`agent_events` 表显示连续 invocation 都 `exitCode=1`,stderr 反复 `No conversation found with session ID: <id>`,且每轮 id 还不一样——形成自我繁殖的脏 id 链。人不清 DB 不自愈。 |
| 2 | **证据** | `agent_events` thread=`8b43322b`, 2026-04-18 18:38:22-18:38:39 完整序列已捞(见下文第三节)。Claude 在 `--resume <miss>` 失败时 emit `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"<崭新随机 id>"}`。`findSessionId(event)` 递归捕获此假 id,`cli-orchestrator.ts:163→191` `onSession(sid)` 上报,`message-service.ts:1180-1185` `emptyAndAbnormal` 因 `result.nativeSessionId !== thread.nativeSessionId` 为 false(新假 id ≠ 旧 id),`effectiveSessionId = 假 id` → `updateThread` 落盘。下一轮 `--resume 假 id` 继续失败。 |
| 3 | **假设** | 三处 bug 串联成死循环(已基本确认):<br>H1 `findSessionId` 不该信任 `is_error:true && num_turns:0` 的 result 事件里的 session_id<br>H2 `emptyAndAbnormal` 的 `result.nativeSessionId === thread.nativeSessionId` 子条件在 H1 成立时恰好失效,应去掉<br>H3 `failure-classifier.ts:67-70` 的 session_corrupt 正则没匹配 Claude 实际措辞 "No conversation found with session ID"(session 字在 found 后面,regex 要求在前面),落 unknown 桶后 F004 `shouldClearSession:false` 兜底失效 |
| 4 | **诊断策略** | (a) ✅ 已看到 agent_events 证据,Claude 侧链路完整 (b) ✅ 已实测三家 CLI(见下文"三家真实 error shape"),Codex 不 emit 假 id(Bug 1 对 Codex 不触发)、Gemini exit=0(Bug 2 对 Gemini 无效,必须走 Bug 3) (c) TDD Red 3 个失败测试 + 1 个端到端回归测试 |
| 5 | **超时策略** | Codex/Gemini 实测若单家 >15 分钟没拿到错误 shape,先用 Claude 完整链路修完,Codex/Gemini 的 classifier 措辞用文档/源码推导(失真风险低,因为它们的 error 文本一般稳定) |
| 6 | **预警策略** | 任何一家 CLI 升级可能改变 error result 结构 → classifier guard 失效 → 死循环复发。修复时在 findSessionId 旁加显式 comment 指向 B017,并补一组 regression 测试钉住行为。 |
| 7 | **用户可见修正** | 已止血:用户房间 `8b43322b` 的 `native_session_id` 已 UPDATE 为 NULL,备份在 `data/multi-agent.pre-heal-2026-04-18T19-03-21.sqlite`。下一轮 `@黄仁勋` 走 F018 Bootstrap 分支,上下文通过 thread_memory + digest 接续。 |
| 8 | **复现验收** | (a) 单元测试:`findSessionId({type:"result",is_error:true,num_turns:0,session_id:"junk"})` === null (b) `emptyAndAbnormal` 路径:exit=1 + empty + 任何 id 差异 → effectiveSessionId=null (c) classifier:`classifyFailure("No conversation found with session ID: abc-123","")` → `class=session_corrupt, shouldClearSession=true` (d) 端到端回归:mock 两轮 --resume 失败,断言 `thread.nativeSessionId` 最终为 null 而不是某个新假 id |

## 现场证据快照(agent_events 表回放)

Thread: `8b43322b-5908-49e2-9a67-684c4dd833c4`,时间窗 `2026-04-18T18:38:22Z – 18:38:39Z`

```
18:38:22  invocation.started  invocationId=f91c7cf7
                              (thread.native_session_id=a8886026-... 被传入 --resume)
18:38:25  stderr              No conversation found with session ID: a8886026-...
18:38:25  stdout result       {is_error:true, num_turns:0, session_id:"8cd770d7-..."}  ← 新假 id #1
18:38:28  stderr              No conversation found with session ID: a8886026-...
18:38:28  stdout result       {is_error:true, num_turns:0, session_id:"0f1a2774-..."}  ← 新假 id #2
18:38:29  invocation.finished exitCode=1
          ↓ 落盘:thread.native_session_id = 0f1a2774 (最后一个被 findSessionId 捕获)

18:38:33  invocation.started  invocationId=8b32a083
                              (thread.native_session_id=0f1a2774 被传入 --resume)
18:38:35  stderr              No conversation found with session ID: 0f1a2774-...  ← 用户看到的这句
18:38:35  stdout result       {is_error:true, num_turns:0, session_id:"c7a85f8a-..."}  ← 新假 id #3
18:38:38  stderr              No conversation found with session ID: 0f1a2774-...  ← 重复(用户看到的"双份")
18:38:38  stdout result       {is_error:true, num_turns:0, session_id:"8f8e85f9-..."}  ← 新假 id #4
18:38:39  invocation.finished exitCode=1
          ↓ 落盘:thread.native_session_id = 8f8e85f9 (继续累积)
```

每一轮 Claude 都额外吐 2 条假 id(不知为何重试了一次 init),每次 findSessionId 取最后一个落盘 → DB 的 native_session_id 不停漂移,但 Claude 磁盘上没有任何一个对应的 jsonl。

## 三家真实 error shape(2026-04-18 实测)

| CLI | 命令 | exitCode | stdout | stderr | 是否 emit 假 session_id |
|---|---|---|---|---|---|
| **Claude** `2.1.113` | `claude --resume 00000000-... --output-format stream-json ...` | `1` | 一条 `{type:"result",subtype:"error_during_execution",is_error:true,num_turns:0,session_id:"<新假 UUID>",errors:["No conversation found with session ID: ..."]}` | `No conversation found with session ID: 00000000-...` | **是** ← Bug 1 触发 |
| **Codex** `cli 0.121.0` | `codex exec resume --skip-git-repo-check --json 00000000-... "test"` | `1` | (空) | `Error: thread/resume: thread/resume failed: no rollout found for thread id 00000000-...` | 否 |
| **Gemini** `0.38.2` | `gemini --resume 00000000-...` | **`0`** ⚠ | (空) | `Error resuming session: Invalid session identifier "00000000-...". Searched for sessions in ... Use --list-sessions ...` | 否 |

**三家触发路径差异**:

- **Claude**:三处 bug 全中 → 死循环。修 Bug 1 切断假 id 污染,修 Bug 2+3 双重兜底。
- **Codex**:Bug 1 不触发(不 emit 假 id),Bug 2 可救(empty+exit=1+id 相同 → emptyAndAbnormal true → 清),Bug 3 不触发(classifier 走 emptyAndAbnormal 路径就够)。但仍建议加 Bug 3 的 Codex 措辞以给用户正确分类提示。
- **Gemini**:Bug 1 不触发,**Bug 2 无效**(exit=0,绕过 `exitCode !== 0` 判断),只能靠 Bug 3 在 `turnLooksFailed=(!content.trim() && !promptRequestedByCli)` 分支走 classifier → session_corrupt → 清。**Bug 3 是 Gemini 的唯一防线**。

**结论**:三家共用 provider-agnostic 修复路径,但实际救命点不同——Claude 靠三层叠防、Codex 靠 Bug 2、Gemini 靠 Bug 3。三处必须同时改,缺一不可。

## 引入时间线

- `findSessionId` 递归抓 session_id 的行为:F006(04a0764)引入,向来如此,但没 error guard
- `emptyAndAbnormal` 的 id 相等条件:**F004(`55bac49`,2026-04-11)引入**
- `classifier.unknown.shouldClearSession: true → false`:**F004(`55bac49`)同时反转**
- 三个 bug 单独任何一个都不会造成死循环;F004 同时改动了 #2 和 #3,把 #1 的潜在雷区激活

## 修复方案(Phase 3 假设)

三家都要覆盖(代码路径共用 provider-agnostic 层)。

1. **Bug 1(守门)**:`base-runtime.ts` findSessionId 加 guard,或 `cli-orchestrator.ts:163` 调用处判 `event.type==="result" && event.is_error && (event.num_turns===0 || !event.num_turns)` 就跳过(不调 onSession)。更稳的口径:只信任每轮开场 `type:"system" subtype:"init"` 的 session_id。
2. **Bug 2(兜底)**:`message-service.ts:1180-1185` `emptyAndAbnormal` 去掉 `result.nativeSessionId === thread.nativeSessionId` 子条件,只判 `!accumulatedContent.trim() && result.exitCode !== null && result.exitCode !== 0` 就 null。
3. **Bug 3(最后防线,对 Gemini 是唯一防线)**:`failure-classifier.ts` session_corrupt 正则基于三家实测措辞改为覆盖:
   - Claude: `no conversation found with session id` / `error_during_execution`
   - Codex: `no rollout found for thread id` / `thread/resume failed`
   - Gemini: `invalid session identifier` / `error resuming session`
   - 原有兜底: `session ... (not found|expired|corrupt|invalid|...)`

### (可选)二线防御

`server.ts` 启动钩子:扫 `threads.native_session_id`,对 Claude 子路径 `~/.claude/projects/<key>/<id>.jsonl` 不存在的自动清空。若本轮超出工作量就延到后续 bugfix。

## Bug Report 六件套

### 1. 报告人

小孙(真人)。房间 `8b43322b-5908-49e2-9a67-684c4dd833c4` `@黄仁勋` 一直调不起来,在黄仁勋的推理面板里反复看到 `No conversation found with session ID: 0f1a2774-7929-456b-bc33-8cd51914208b`(且连续出现两次),要求追查是哪个 feature / bugFix 引入的。

### 2. Bug 现象

Multi-Agent 房间 `@黄仁勋`,每轮 invocation `exitCode=1`(Claude) 或 `exitCode=0 + empty`(Gemini),推理面板循环显示 `No conversation found with session ID: <id>`,且每次 id 不同——**自我繁殖的脏 id 链**,人不清 DB 不自愈。

### 3. 复现步骤

**期望**:`@黄仁勋` 正常接续回复,上下文不丢。

**实际**:任何 `thread.native_session_id` 指向的 Claude session 文件一旦不存在,就进入死循环(详见正文"现场证据快照")。

可人工复现(与 acceptance-guardian 本次实测一致):
```bash
claude --resume 00000000-0000-0000-0000-000000000000 \
  --output-format stream-json --include-partial-messages --verbose \
  --permission-mode bypassPermissions <<< "test"
```
→ stderr: `No conversation found with session ID: 00000000-...` + stdout result `{is_error:true, num_turns:0, session_id:"<崭新 junk uuid>"}`

### 4. 根因分析

三处 bug 串联成死循环(详见正文"诊断胶囊"+"三家真实 error shape"):

1. **`findSessionId` 捕获 error-result 里的假 session_id**(`base-runtime.ts`):Claude CLI 在 `--resume <miss>` 失败时 emit `{type:"result", is_error:true, num_turns:0, session_id:"<junk>"}`,递归扫描把它当成真 session
2. **`emptyAndAbnormal` 的 id 相等子条件**(F004 `55bac49` 引入):id 漂移时 false → 假 id 不被清,持久化到 DB
3. **`failure-classifier` 正则只认 "session ... (not found|...)"**,不认 Claude 实际措辞 "No conversation found with session ID";F004 同时反转 `unknown.shouldClearSession` 为 false,两层兜底同时失效

三家 CLI 触发路径差异:
- Claude — 三处全中 → 死循环
- Codex — Bug 1 不触发,Bug 2 可救
- Gemini — exit=0,Bug 2 无效,**Bug 3 是唯一防线**

### 5. 修复方案

三层叠防,provider-agnostic 层改动,三家都受益:

1. **`base-runtime.ts` findSessionId 加 guard**:`value.type === "result" && value.is_error === true` → null。拒绝信任任何 error result 的 session_id。
2. **抽 `services/session-effectiveness.ts` 纯 helper `computeEffectiveSessionId`**,`message-service.ts:1180` 切过去。删除 id 相等子条件,empty + `exitCode !== 0` 无条件清。保留 `exitCode !== 0` 前置(避免退回 F004 之前"normal-exit empty 也清"的过激行为)。
3. **`failure-classifier.ts` 正则扩展三家实测措辞** + 保留原有 "session ... (not found|...)" 兜底。Gemini 的 "Invalid session identifier" 必须被识别,因为 exit=0 时它是唯一防线。

**放弃的备选**:
- 启动扫 `threads.native_session_id` 对照 `.claude/projects/*` 文件存在性的第四层防御 — 三层纵深已够,扫描要处理三家 CLI 不同的 path 映射,维护成本 > 收益
- 只补 classifier 不改 findSessionId — 治标:不阻止假 id 被 record 到 DB,classifier 漏掉任何措辞就复发
- 只改 `emptyAndAbnormal` 不改 findSessionId — 救 Claude+Codex,但 Gemini exit=0 救不了

### 6. 验证方式

绑定复现步骤:

1. **Unit 级**(本次新增 17 条测试):
   - `base-runtime.find-session-id.test.ts` 6 条 — is_error=true 情况跳过、is_error=false/init event 仍捕获
   - `session-effectiveness.test.ts` 6 条 — id 漂移场景正确 null,normal exit=0 仍保留 session
   - `failure-classifier.test.ts` +5 条 — 三家实测措辞都走 session_corrupt,原用例无回归
2. **全量**:`pnpm test` 781/781 pass(本次真实运行)
3. **typecheck/build/lint**:全 exit 0
4. **独立守护**(acceptance-guardian 零上下文):三家 CLI 实测 shape 100% 吻合 bug report;F004/F018/B012/B015 相关 63 测试无回归;acceptance-guardian 本机实测 Claude 真的回铸了 `f07cea1f-...` 假 id(完整复现)
5. **Peer Review**(范德彪/Codex):PASS 放行。2 条非阻塞 residual risk 入档:
   - `error_during_execution` 短语偏宽但 classifier 实际只吃 stderr 不吃 stdout,真正兜住 Claude 的是 "No conversation found with session ID"
   - Gemini 长期依赖 vendor wording 稳定,drift 风险在未来
6. **端到端人工验收**:用户房间 `@黄仁勋` 恢复后,下一轮走 F018 Bootstrap 接续(`thread_memory` 417 字符 + 3 段 digest + `writing-plans` SOP bookmark 全在)

**已止血**:用户房间 `8b43322b` 的 `native_session_id` 已人工置 NULL,备份 `data/multi-agent.pre-heal-2026-04-18T19-03-21.sqlite`。本次 merge 后 `@黄仁勋` 即可恢复。
