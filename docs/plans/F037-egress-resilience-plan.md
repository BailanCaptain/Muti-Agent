# F037 Egress Resilience Implementation Plan

**Feature:** F037 — `docs/features/F037-daily-news-digest.md`
**Goal:** 在不改变代理配置、信源清单和邮件内容合同的前提下，使短时共享代理故障不再造成日报信源集中失败。
**Acceptance Criteria:** source 默认最大并发为 6 且结果顺序稳定；共享同一上游的 source 可声明组内并发上限和最小启动间隔，同 key 在启动前取最小并发/最大间隔，YouTube feed 固定为 1 / 1.5 秒；所有 source HTTP 自动绑定总预算 signal，同一底层 `http/httpDirect` 不破坏身份去重；显式 opt-in 的幂等 GET 在整个 source 内最多共享一次 transport retry；永久错误、POST 和普通 fallback 链不被放大。YouTube 主 feed 使用 3 秒 backoff，只有主站可消费 retry token，两次仍失败或 parser-zero 后都只走一次同属官方域的 mobile fallback；完整 shadow 预检 43/43 健康后，仅向 `sundengjun1` 重发一次。
**Architecture:** orchestrator 使用 group-aware 保序就绪调度器替换无界 `Promise.all`：启动前预聚合同 key 组配置，只让当前可运行的 source 占全局槽，blocked group 留在 pending，并在 source 计时前原子保留共享上游组槽位与 pacing；每个 source 获得绑定 AbortSignal 的 `http/httpDirect` wrapper，同一底层 client 复用 wrapper。单路 registry feed 与 GitHub 声明 retry policy，整个 source 共享一枚 token；12 个 YouTube feed 声明同一 concurrency group，并登记 `www`/`m` 两个 YouTube 官方 feed 路由，retry hostname allowlist 只放行主站。现有 SafeHttpClient 继续负责 SSRF、逐跳校验与单请求 20 秒。
**Tech Stack:** TypeScript、Node test runner、tsx、pnpm、现有 SafeHttpClient/ProxyAgent。

---

### Task 1: 锁定无界 source fan-out

**Files:**
- Modify: `packages/api/src/services/daily-digest/orchestrator.test.ts`
- Modify: `packages/api/src/services/daily-digest/orchestrator.ts`

1. 写 gate 测试：12 个阻塞 source 在未释放前最多启动 6 个，并验证显式并发 2。
2. 运行 orchestrator 测试，确认旧实现因全部 source 同时启动而失败。
3. 实现按索引写结果的 group-aware 就绪调度器；source 计时器只在取得全局与组内执行资格后创建。
4. 验证逆序完成仍保持输入顺序，排队时间不计入单源预算。
5. 用三次真实 shadow 与组探针锁定 YouTube 二级故障面；写组内上限/最小间隔 RED，声明 12 个 YouTube feed 共用 `youtube-feed:1/1500ms`，组内排队不启动 source 预算。
6. 以代理随机 500、直连超时和 mobile 官方入口 6/6 对照，写 `www ×2 → m ×1` RED；只增加同属 YouTube 的固定备用路，不引入第三方镜像或新凭证。
7. 用生产排列“12 个连续组内 source + 第 13 个独立 source”锁定 blocked group 不占全局槽；旧实现 RED `false !== true`，就绪调度器 GREEN。
8. 用后置严格同 key 配置锁定顺序无关；在启动任何 source 前按最小并发与最大间隔预聚合。

### Task 2: 锁定 source-bound transport 的瞬时恢复

**Files:**
- Modify: `packages/api/src/services/daily-digest/orchestrator.test.ts`
- Modify: `packages/api/src/services/daily-digest/sources/registry.test.ts`
- Modify: `packages/api/src/services/daily-digest/sources/registry.ts`
- Modify: `packages/api/src/services/daily-digest/sources/github-trending.ts`
- Modify: `packages/api/src/services/daily-digest/types.ts`

1. 写独立 fetcher 未传 signal 时的 `network → success`、`timeout → success` RED。
2. 写 source 总预算必须真正中止底层请求、`httpDirect` 同样恢复的 RED。
3. 实现 source-bound wrapper：合并调用方/source signal，只有 opt-in GET 可消费一次共享 token。
4. registry 单路 RSS/JSON 自动 opt-in；YouTube 把显式 HTTP 状态迁到同一 policy；GitHub 四源 opt-in。
5. 写 POST、永久错误、多 URL fallback、YouTube `network→404` 两次硬上限与 backoff abort 守卫。
6. 写 `http === httpDirect` 单 URL 去重与 YouTube `www parser-zero → mobile network` 守卫；mobile 终末 fallback 始终单次。

### Task 3: 文档、回归与独立验收

**Files:**
- Modify: `docs/bugReport/B043-digest-egress-burst-failure.md`
- Modify: `docs/features/F037-daily-news-digest.md`
- Modify: `docs/discussions/F037-sources-v2-expansion.md`
- Modify: `docs/lessons/lessons-learned.md`

1. 将 F037 旧“其他源不全局重试”边界更新为普通单路幂等 GET 有界重试。
2. 运行目标测试、F037 专项、API typecheck/lint 与全量回归。
3. 在 worktree 同源环境完成 quality-gate、acceptance-guardian 和 peer review。
4. 修复所有 P1/P2 后提交并进入 merge-gate。

### Task 4: 上线与单收件人重发

**Files:**
- Create local-only: `.runtime/daily-digest/manual-shadow-B043-2026-07-24.ts`
- Create local-only: `.runtime/daily-digest/manual-resend-B043-2026-07-24.ts`

1. 合入 `dev` 后只重启 Multi-Agent 项目服务并验证 API/Web/scheduler。
2. 在独立 shadow root 以 mock sender 运行锁定 `2026-07-24` 的完整 force reconcile。
3. 要求 43/43 source `ok`、无 SOURCE ALERT、production archive/ledger/shown/config 哈希未变。
4. 锁定 HTML/hash/bytes，preflight 确认 SMTP envelope 只有 `sundengjun1`。
5. 用唯一 operation/marker 只发送一次；成功后核对 messageId 与 outbound ledger，结果未知时禁止自动重试。
