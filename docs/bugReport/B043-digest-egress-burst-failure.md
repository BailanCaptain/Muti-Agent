---
id: B043
title: F037 日报共享代理瞬断导致 25 个信源集中失败
status: fixed
reported_by: 小孙
reported_at: 2026-07-24
related: F037
---

# B043 — F037 日报共享代理瞬断导致 25 个信源集中失败

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | 2026-07-24 正式日报 43 个源中仅 18 个 `ok`，24 个 `failed`、1 个 `timeout`；GitHub 板块为 0，最终邮件仍按源异常卡形式发出。 |
| 2 | **证据** | Clash sidecar 在 07:30:13 对 Qwen、GitHub、HF、YouTube、Google、BBC、HN、V2EX、知乎、百度、头条、Digg、Reddit 等连续记录 27 条同一上游 `fr.z.claw-api.xyz:7000 connect error: context deadline exceeded`。日报健康账为 9 个 `SafeHttp[timeout]`、15 个 `SafeHttp[network]`、1 个 45 秒源级超时。12 个 YouTube 首跳同样失败，但因有一次重试而全部恢复。 |
| 3 | **假设** | 已证实的直接原因是共享代理上游瞬断；代码缺口是 43 个 source 由无界 `Promise.all` 同时启动，且普通单路幂等 feed 对 transport 瞬断没有受控重试。两者叠加，把数秒级出站故障固化成 25 个源失败。 |
| 4 | **诊断策略** | 对照 07-23 正常轮（42/43 ok）与 07-24 异常轮；检查 ProxyAgent、orchestrator fan-out、现有 YouTube retry 反事实；以 worker gate 和 `network/timeout → success` fixture 分别锁定无界并发与缺重试。 |
| 5 | **超时策略** | 若 30 分钟内 RED 不能精确命中两个缺口，停止叠加补丁，回到真实 sourceHealth/sidecar 时间线重新划分故障域；若修复超过 3 处行为面，升级为架构复审。 |
| 6 | **预警策略** | 若需要修改 `.env`、代理节点、SafeHttp 安全校验、发送白名单，或会让 POST/永久错误进入自动重试，立即停止并上报。 |
| 7 | **用户可见修正** | 不改邮件版式、栏目、信源清单或代理配置；修复后代理瞬断不再因同一时刻 43 路突发而大面积固化失败。重发只允许单独投递给 `sundengjun1`，不得群发。 |
| 8 | **复现验收** | RED：默认启动 12/12 个 source；连续 12 个组内 source 会占满 6 个全局 worker并阻塞后置独立源；后置的同 key 严格配置无法约束已启动 source；`http === httpDirect` 时 wrapper 身份丢失造成同 URL 重复请求；YouTube 主路 parser-zero 后 mobile 会误吃遗留 token；独立 fetcher 的首次 `network/timeout` 直接失败；未显式传 signal 的底层请求在 source 超时后仍悬挂。GREEN：group-aware 就绪调度器默认并发上限 6、blocked group 不占全局槽、同 key 在启动前按最严格配置聚合、结果顺序不变；同一底层 HTTP client 复用 wrapper；所有 source-bound HTTP 自动绑定总预算 signal；显式 opt-in 的幂等 GET 共享且最多消费一次 retry token，YouTube 仅主站可消费，POST、永久错误和 fallback 链不放大。完整 shadow 预检要求 43/43 健康后才允许单收件人 SMTP。 |

## 原始需求

> “什么情况啊 今天的日报25个信源失败”
>
> “修改一下 然后重发一份！！！！”

## Design Gate

比较了三种方案：

1. 仅增加重试：仍会在同一代理上形成 43 路首波和同步第二波，且独立 fetcher 覆盖不完整，否决。
2. 仅限制并发：能错峰，但首批命中瞬断的源仍会失败，否决。
3. **两层并发门控 + source-bound HTTP + 一次受控重试**：默认由 group-aware 就绪调度器最多启动 6 个 source，组内 blocked source 留在 pending、不占全局槽；共享同一上游的 source 可再声明组内上限和最小启动间隔，同 key 配置在任何 source 启动前取最小并发/最大间隔，12 个 YouTube feed 固定串行且间隔 1.5 秒；每个 source 的 `http/httpDirect` 自动绑定同一总预算 signal，同一底层 client 复用同一 wrapper；单路 feed 与 GitHub 显式 opt-in，并在整个 source 内共享一枚 retry token。YouTube 主 feed 使用 3 秒退避，且仅 `www.youtube.com` 可消费 token，主路两次仍失败或 parser-zero 时都只走一次同属 YouTube 官方域的 mobile feed。采用。

边界：不修改共享 SafeHttp 安全合同、ProxyAgent、`.env` 或代理节点；不重试 POST、403、SSRF/redirect/size 类永久错误；普通多 URL/direct→proxy、多账号或多 feed 源默认只获得 signal 绑定，不逐跳重试。YouTube 的 404 等显式状态与 transport 错误共用一枚 retry token：`www` 主路最多两次，随后 `m.youtube.com` 官方备用路最多一次；主路若 HTTP 成功但 parser-zero，mobile 也不得消费遗留 token，总请求硬上限仍为 3。

## 实网迭代证据

1. 首版“全局并发 6 + 一次 retry”影子全链为 `42/43`；唯一失败 `yt-karpathy` 连续两次 500，说明跨域雪崩已消失，但同域 12 路仍会形成二级突发。
2. 第二次影子全链为 `41/43`；`yt-lex-fridman`、`yt-deepmind` 连续两次 404。两源数分钟后的单源探针立即恢复，排除固定 URL/频道失效。
3. 因此补入声明式 `concurrencyGroup`：等待组内槽位发生在 source 计时开始前，YouTube feed 组 `maxConcurrency=1`。第三次完整 shadow 跨域源全部恢复，但 `yt-ai-explained` 连续两次 404，仍只有 `42/43`；邮件内容虽为 `status=ok / degraded=false`，发送硬门主动拦截。
4. 进一步实测：本机直连 YouTube 20 秒超时；当前代理对同一 `www.youtube.com` feed 六次中随机两次 500；`m.youtube.com` 官方入口连续 `6/6` 成功并重定向到同一官方 Atom。于是保留代理，增加 1.5 秒组间隔、3 秒 retry backoff 和单次 mobile 官方 fallback。12 源现网组探针连续两轮均为 `12/12`。
5. 预审随后发现组内 waiter 会占住全局 worker；生产排列的 12 个连续 YouTube 源可让后置独立源最坏多等约 `7 × 45s`。新增生产形态 RED 确认旧实现为 `false !== true`，改为 group-aware pending scheduler 后目标 `21/21`、orchestrator + registry 独立复核通过。
6. 最终 peer review 再以三个边界 RED 收紧合同：同 key 配置先全量聚合，避免后置严格声明失效；`http === httpDirect` 时复用 wrapper，恢复 fallback 的身份去重；YouTube 主路 parser-zero 后，mobile 不得消费遗留 retry token。旧实现分别出现 `active=2 / gap=7ms`、同 URL 两次请求和 `[www,m,m]`，修复后联合专项 `53/53`、reviewer `Confirmed / Approved`。
7. 最终完整 shadow（`attempt6`）为 `43/43 ok`、无 SOURCE ALERT、`status=ok / degraded=false`、HTML `81,353 < 100,352` bytes；正式 archive/health/ledger/shown/config 与完整 production runtime tree 哈希全部不变。最终 Quality Gate：API `4,727 pass / 0 fail`（另 1 skip、1 todo）、components `903/903`，合计 `5,632` tests / `5,630` pass；typecheck/build/lint/check/diff 全通过。

## 收敛检查

1. 否决理由 → ADR？没有；仅影响 F037，本报告记录足够。
2. 踩坑教训 → lessons-learned？有；当前修复完成后追加“单代理无界 fan-out 会把瞬断放大为源雪崩”。
3. 操作规则 → 指引文件？没有；不是全项目 agent 操作规范。
