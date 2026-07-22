# B040 — 本机 RSSHub 被日报全局代理错误接管

**Status:** verification
**Related:** F037

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | 2026-07-21、2026-07-22 的 `x-firsthand` 均为 `failed`，35/35 账号抓取失败，首错为 `SafeHttp[network] http://localhost:1200/twitter/user/OpenAI — TypeError: fetch failed`。 |
| 2 | **证据** | 7 月 20 日 X 仍为 `ok`；今天 42/43 源正常。RSSHub 容器运行且 `0.0.0.0:1200` 在监听；容器日志未收到日报失败时段的 X 请求。同轮 thepaper 的本机 RSSHub 首跳也发生同类 network failure，备用源成功。API 启动日志显示全局代理 `127.0.0.1:7897` 已启用。 |
| 3 | **假设** | H1（已确认）：显式 `ProxyAgent` 不消费 `NO_PROXY`，而 RSSHub provider 始终使用 `ctx.http`，导致受信任的本机 RSSHub 请求被送进代理；现有 `ctx.httpDirect` 未被 X provider 使用。 |
| 4 | **诊断策略** | 对照 `boot.ts` 的代理/直连 client、`orchestrator.ts` 的 context 传播、`registry.ts` 的 direct 模式与 `x-provider.ts` 的固定 `ctx.http`；用 proxy client 抛错、direct client 返回 RSS 的组合测试复现。 |
| 5 | **超时策略** | 组合测试 15 分钟内若不能稳定复现，退回 transport seam，记录 proxy/direct 调用计数，不做真实网络探测。 |
| 6 | **预警策略** | 若修复需要修改 `.env`、Cookie、Docker 配置或访问无关 localhost 端口，立即停止并升级给小孙。 |
| 7 | **用户可见修正** | X 一手动态恢复进入日报；不改变外网源代理策略，不自动补发今天已发送的日报。 |
| 8 | **复现验收** | RED 证明旧实现调用 proxy；GREEN 证明 loopback RSSHub 调 direct，而远端 RSSHub 与 TwitterAPI.io 仍调 proxy；跑 X provider、orchestrator、daily-digest job 回归。运行态只验证进程重启后的下一次抓取，不改 Cookie。 |

## Bug Report 六件套

1. **报告人：** 小孙在 2026-07-22 日报中发现 X 信源仍失败；范德彪按 health、summary、API/RSSHub 日志定位。
2. **Bug 现象：** 日报正常发送，但 `x-firsthand` 为 0 条并在健康记录中标记 35/35 全灭。
3. **复现步骤：** 启用全局 HTTP(S) 代理与本机 `MULTI_AGENT_DIGEST_RSSHUB_BASE=http://localhost:1200`，运行 F037 抓取；期望 RSSHub 走本机直连，实际请求由显式 ProxyAgent 接管并在取得 HTTP 响应前失败。
4. **根因分析：** `boot.ts` 已创建 `httpDirect` 并由 orchestrator 下发，但 `makeXSource` 没把它传给 provider；RSSHub provider 固定调用 `ctx.http`。显式 ProxyAgent 不读取 `NO_PROXY`，所以 trusted origin 只绕过 SafeHttp 的 SSRF 校验，没有绕过传输代理。
5. **修复方案：** 扩展 X provider context 以接收既有 `httpDirect`；仅 loopback RSSHub（`localhost` / `127.0.0.0/8` / `::1`）使用直连，远端自建 RSSHub 与 TwitterAPI.io 保持 `http` 代理通道。不修改配置、Cookie 或 RSSHub 容器。
6. **验证方式：** 先按 TDD 记录 RED/GREEN；再跑相关 API 测试、类型检查与质量门禁，并在项目 API 重启后观察下一轮 X source health。

## TDD 与当前验证证据

- **RED：** 新增“proxy client 抛错、direct client 返回 RSS”的生产路径测试；旧实现 `22/23`，唯一失败明确为 `trusted RSSHub request must not enter ProxyAgent`。
- **GREEN：** `makeXSource` 透传既有 `httpDirect`，loopback RSSHub 选择 direct；同一测试转绿。
- **边界锁：** 远端自建 RSSHub 与 TwitterAPI.io 在存在 `httpDirect` 时仍只使用 `http`，防止需要代理的外部地址回归。
- **Review 修正：** 首轮 review 的远端 RSSHub 反例先 RED（旧改法固定 direct，无法走 proxy），再以 loopback origin 判定收窄直连策略；X provider `25/25`。
- **定向回归：** X provider、orchestrator、boot、daily-digest job 合计 `88/88` 通过。
- **类型检查：** `pnpm --filter @multi-agent/api typecheck` 通过。
- **运行边界：** Node 24 对仅监听 IPv4 的本项目 `localhost:8787` 与 `127.0.0.1:8787` 均返回 200，排除本机 `localhost` 解析本身；未访问 RSSHub 端口。

## Quality Gate（2026-07-22）

| 检查 | 结果 |
|------|------|
| 原始诉求 | “X 还是失败的信源”——本次只修 X→RSSHub 的 transport，不改内容、鉴权或发送语义。 |
| 定向生产路径 | `88/88`，含 loopback direct、远端 RSSHub proxy、TwitterAPI.io proxy 边界、orchestrator、boot、job。 |
| 全量测试 | `pnpm test` exit 0（API + components）。 |
| 类型 / 构建 | `pnpm typecheck` exit 0；`pnpm build` exit 0。 |
| Lint | 全仓 exit 0，75 个既有 warning；本次两个代码文件单独 lint 为 0 diagnostics。 |
| 文档 / ADR | `pnpm check` exit 0；docs/ADR clean，4 个既有 skill warning。 |
| Diff | `git diff --check` exit 0；无配置、Cookie、Docker 或账本改动。 |

**门禁结论：** 代码与可重复复现路径通过；生产 RSSHub 恢复需合入并重启项目 API 后，由下一次抓源健康记录确认。本报告在该运行态证据出现前不宣称生产源已经恢复。
