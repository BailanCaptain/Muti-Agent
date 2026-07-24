# EP-003: F037 共享出站韧性从逐源补丁升级为 source 级合同

> 状态：accepted
> 提案人：范德彪
> 日期：2026-07-24

---

## 1. Trigger（触发）

2026-07-24 正式日报因代理上游瞬断出现 25 个非成功源；这不是首次同类事件，B029 的真实补发也曾仅 6/43 源正常。

## 2. Evidence（证据，至少 2 个来源）

| # | 来源 | 证据 |
|---|------|------|
| 1 | B029 非阻塞运行观测 | 同一代理下仅 6/43 源正常，GitHub 四榜全部 `fetch failed`，事后同路复测恢复。 |
| 2 | B043 正式日报与 Clash sidecar | 07:30:13 跨 20 余域名集中记录同一上游 deadline；日报 24 failed + 1 timeout；有二次机会的 YouTube 12/12 恢复。 |
| 3 | B043 前两次修复 shadow | 全局并发 6 后分别为 42/43、41/43，失败只剩 YouTube 且随后单源探针恢复，证明还需表达同上游二级并发边界。 |
| 4 | B043 第三次 shadow 与路由对照 | 串行后仍有单个 YouTube 连续 404；代理同 URL 六次随机两次 500，直连 20 秒超时，mobile 官方入口 6/6 成功。 |
| 5 | B043 最终 shadow 与调度复审 | 生产排列 RED 证实组等待会占满全局 worker；终审再锁定同 key 顺序依赖、direct client wrapper 身份与 mobile 遗留 token 三个边界，全部 Confirmed / Closed；最终 shadow 43/43、无 SOURCE ALERT、非降级且正式状态哈希不变。 |

## 3. Root Cause（根因）

F037 只有单源错误隔离，没有共享 egress 的并发上限；transport retry 是 YouTube 局部特例，且 source AbortSignal 依赖每个调用点手工传递。相同代理抖动因此会重复表现为不同“坏源”事故。

## 4. Lever（最小杠杆改动）

- **改什么**：只改 F037 orchestrator 与 source retry 声明，不改共享 SafeHttpClient 或全项目 SOP。
- **怎么改**：默认由 group-aware 就绪调度器保序收集、最多运行 6 个 source，blocked group 不占全局槽；相同上游可声明组内并发上限与启动间隔，同 key 在启动前按最严格值聚合，YouTube feed 固定串行 / 1.5 秒；source-bound HTTP 自动绑定总预算 signal，相同底层 direct/proxy client 复用 wrapper；单路幂等 GET 与 GitHub 共享一次 retry token；YouTube 仅允许主站消费 token，再以固定 mobile 官方路由承担单次终末 fallback。
- **为什么这是最小杠杆**：故障域只在 F037 的共享出口编排；提升到全局 SafeHttp 会把 F041 POST/外部业务一并改变，范围过大。

## 5. Verify（验证方式）

- **短期**：B043 RED→GREEN；同源 shadow 全链要求 43/43 健康，再单收件人重发。
- **长期**：未来 30 天日报健康账不得再出现同秒跨域 network/timeout 雪崩；若代理仍故障，日志应显示受控 retry、最多 6 个活跃 source，YouTube feed 同时最多 1 个且有 1.5 秒间隔，而不是 43 路或同域 12 路同步失败；mobile fallback 只能在主路耗尽后单次触发。

---

## 审批

- [x] 影响范围确认：单 feature（F037）
- [x] 小孙拍板：2026-07-24 “修改一下 然后重发一份”
- [x] 落地 commit：B043 feature commit（本提交；合入后由 merge-gate 校验）
