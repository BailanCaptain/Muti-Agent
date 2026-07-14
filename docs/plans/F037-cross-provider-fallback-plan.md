# F037 跨 Provider 终极兜底实施计划（B030）

**目标：** 在不改变原有日报格局、编辑门禁和两列模型配置的前提下，为摘要、翻译补全与播客提炼增加固定的第三层 Codex 兜底：`gpt-5.6-sol`，推理强度固定 `high`。

**Bug：** [B030](../bugReport/B030-digest-cross-provider-fallback.md)

## 验收合同

1. 默认链路严格为 Claude 主力 → Claude 备用 → Codex `gpt-5.6-sol/high`。
2. 任一层成功立即停止；相同 target 只调用一次；abort 立即停链。
3. 同一 provider-aware runner 同时用于日报摘要、额外文本翻译与播客提炼。
4. Codex 预取消时不得 spawn；运行中取消必须终止子进程树并返回 `aborted`。
5. 设置存储 schema 不变；GET 下发只读终极兜底描述，PUT 不能覆盖它，保存 payload 不包含它。
6. 设置页保留原来的两列布局与文案，只增加一行只读最终兜底说明。
7. 所有既有 JSON、编辑审核、推理/非推理覆盖、发布清单和“宁缺勿发”门禁保持不变。
8. 慢模型不因紧时限误杀：Claude 至少 6h/层；最终 Codex/high 至少 12h，调用方小值不得缩短。播客下载/ffmpeg 各 30min、STT 1h/段、整源 96h；整任务 14d watchdog 严格大于保守全链最坏账 864750s。超时只防真正挂死，不参与内容审核。
9. provider 原始 stderr 不得进入日报日志或聚合错误；仅保留 `timeout/aborted/exit-code/spawn-error/empty-output/quota-or-rate-limit/provider-error` 等闭集分类。

## Non-goals

- 不修改 `.env`、MCP/runtime 配置或持久化密钥。
- 不把 provider/effort 做成通用可编辑设置，不迁移历史配置。
- 不改变邮件布局、栏目名、摘要文案或开源榜单规则。
- 不在质量门禁、独立验收和 review 前发送真实邮件。
- 不扩展为“JSON 解析失败立即换 provider”；继续使用 B029 的原门禁与定点重试。

## Task 1：RED — 三层链与取消合同

1. 新建 `model-runner.test.ts`，锁定主力成功、备用成功、第三层成功、全败、目标去重和 abort 停链。
2. 扩展 `wiki-compile-cli-runners.test.ts`：预取消不 spawn；运行中取消调用 `killTree`、返回 `aborted` 且只 settle 一次。
3. 扩展 `daily-digest.test.ts`：GET 必须返回固定只读描述；PUT 伪造 `emergencyFallback` 必须 400。
4. 扩展 `digest-settings-model.test.ts`：显示文案固定为 GPT-5.6 Sol / Codex / high，保存 payload 永不出现只读字段。

检查点：新增测试在当前实现上按预期失败，记录失败断言，不先改生产代码。

## Task 2：GREEN — Provider-aware 三层 runner

1. 新建 Daily Digest 专用 model runner：定义固定终极目标、目标归一化/去重、顺序执行与 abort 停链。
2. Claude 目标继续用 `createClaudeModelRunner`；固定第三层用 `createCodexPromptRunner({ model: "gpt-5.6-sol", effort: "high" })`。
3. `boot.ts` 每轮以 effective primary/fallback 构造三层 runner，并保持摘要、翻译补全与播客共用同一实例。
4. Codex CLI runner 接入 AbortSignal：预取消直接返回 `aborted`；运行中取消进程树并清理 listener/timer。

检查点：Task 1 全绿；既有 boot/summarizer/podcast runner 测试无回归。

## Task 3：GREEN — 只读设置呈现

1. settings GET 增加 `emergencyFallback` 只读对象，真相源来自后端固定常量。
2. 前端响应类型接入只读对象，并用纯函数生成稳定中文说明。
3. 原两列输入、datalist、存储 diff 逻辑保持不变；只在模型卡片下追加一行说明。

检查点：路由与前端 model 测试全绿；PUT 不能写入终极兜底。

## Task 4：结构化实测与全链预检

1. 用当前 Codex CLI 对 `gpt-5.6-sol/high` 跑日报结构化输出探针，交给 production parser 验证。
2. 在 worktree 隔离根目录使用 mock sender 跑一次完整 reconcile，不触碰真实账本或 SMTP。
3. 核对 43 源健康、播客 STT→LLM 提炼、摘要、归档与最终 HTML；异常必须按阶段报告，不得用发信掩盖。

## Task 5：门禁、独立验收与 Review

1. `quality-gate`：对照 B030 七条验收合同、愿景和 non-goals。
2. `acceptance-guardian`：零上下文 agent 在同源 worktree 复跑复现与验证。
3. `requesting-review`：按五件套请求 Claude Opus 4.8 正式只读 review；若组织权限仍阻断，必须如实报告并使用独立 reviewer 补位，不能伪称已完成指定 review。
4. P1/P2 按 `receiving-review` 做 VERIFY + RED→GREEN；未放行不补发。

## 实施结果（2026-07-14）

- 三层 runner、Codex AbortSignal、只读设置呈现与 B031 provider-aware timeout 已完成 Red→Green。
- 完整隔离 mock reconcile：43/43 源健康，首稿 strict 诊断点出 6 个 rejected 引用，第二稿修正通过；`status=ok`、`degraded=false`、六件归档与 mock 邮件齐全。
- 成品独立内容审计 PASS：社区 9/9 合格；AI 推理 6/16、非推理 10/16；开源四榜 19/19 为 `yes`。
- Guardian R3 曾 PASS；备用 peer review 随后发现 2P1+2P2：配置可折叠成单层 Codex、Windows Claude 只杀 shell、community pick 纯 reaction 门缺口、`mcp` topic 缩写碰撞。四项已按 VERIFY + RED→GREEN 修复，目标 58/58、扩展定向 310/310。
- Guardian R4 又以三条原始社区标题证明：AI 实体本身仍可包装个人 offer 求助、加班薪资抱怨和 ChatGPT 相亲闲聊；修复前 publication 6/7 RED，最终门复用社区性质门后 7/7、邻接 59/59。该变化须由全新 R5 与 reviewer 复验。
- 备用复审再抓到正文性质错位和 GPT/vLLM 长纯 reaction 穿透；最终门现要求原始事实含发布事件、事实动作或技术细节，并以独立高置信正文门拦个人噪声，同时保留真实技术讨论和算法评测。小孙随后要求“只要能出来日报，不要过多限制慢模型”，全链保险丝扩为 Claude 6h / Codex 12h / podcast 96h / scheduler 14d。
- Claude Opus 4.8 CLI 因组织禁用 subscription access 无法执行，环境也无 API/云厂商凭据；该门禁仍如实标为未完成。代码变化后须重新独立验收、复审，再真实补发。

## 三件套收敛

- **ADR**：不新增；B030 是 F037 局部接线修复，替代方案已记录在 Bug Report。
- **Lesson**：完成后沉淀“UI 出现模型 ID 不等于运行时真正跨 provider”的一次性教训。
- **Rule**：不新增全局规则；现有 TDD、provider 接线验证和 fail-closed 证据合同已覆盖。
