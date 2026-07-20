---
title: F037 日报重启后启用环境丢失导致整日未发送
status: resolved
related: F037
reported: 2026-07-20
---

# B038 — F037 日报重启后启用环境丢失

Related: [F037](../features/F037-daily-news-digest.md)

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | 2026-07-20 07:30 后没有日报邮件；当天没有归档、health、attempt ledger 或 outbound ledger。 |
| 2 | **证据** | API 于 00:37:45 重启；`.runtime/api.log` 只注册 `cronJobs=7/startupJobs=1`，而 F037 启用合同为 `9/2`。00:38:54 已取得 leader term 41，其他任务持续运行。 |
| 3 | **假设** | 已确认停止点是 `isDigestEnabled(process.env) = false`。更深层可能是本次启动未继承 `.env`，或临时 `MULTI_AGENT_DIGEST_ENABLED=0` 覆盖；旧日志未记录安全原因码，不能反推二者。 |
| 4 | **诊断策略** | 对照 `boot.ts` 启用门、`server.ts`/`scheduler-bootstrap.ts` 装配路径、启动命令与 job traces；检查当天四类产物是否存在。 |
| 5 | **超时策略** | 若无法从已退出父进程恢复环境块，不猜历史瞬时值；修复到“入口无论由 bat 还是直接 tsx 启动都窄读日报前缀”，并增加原因码。 |
| 6 | **预警策略** | 若需要改 `.env`、全量加载 dotenv、泄露 SMTP 值或绕过发送账本，立即停止。运行时重启和补发必须由小孙明确授权。 |
| 7 | **用户可见修正** | 小孙已于 2026-07-20 授权修复、重启并补发今日正式日报；补发仍走同一 reconcile/ledger，禁止旁路 SMTP。 |
| 8 | **复现验收** | 已完成：仅根 `.env` 配齐时启动装配注册 `9 cron/2 startup`；API 取得 leader term 42 后，经同一 send-now/reconcile/ledger 入口只触发一次，2026-07-20 账本 `attempts=1`、`sent=true`。 |

## Bug Report 六件套

1. **报告人**：小孙；2026-07-20 发现预期 07:30 日报未收到。
2. **Bug 现象**：不是抓源、摘要或 SMTP 失败，而是 API 重启后日报三个调度入口均未注册，因此全天没有执行痕迹。
3. **复现步骤**：在 API 进程环境没有日报变量、磁盘 `.env` 有 `MULTI_AGENT_DIGEST_*` 的启动方式下直接运行 `tsx packages/api/src/index.ts`；旧实现只读 `process.env`，启用门返回 false。预期应只读日报前缀并启用；实际 scheduler 为 `7/1`。
4. **根因分析**：`start-project.bat` 会注入 `.env`，但 API 入口与 F037 装配本身完全依赖父进程环境；任一绕过/异常启动都会静默关闭日报。启用门还只返回 boolean，不记录禁用原因，导致静默缺报。
5. **修复方案**：新增只读 `MULTI_AGENT_DIGEST_*` 前缀解析器，进程环境按“键存在即覆盖”且显式 `0` 最高优先；同一环境快照传给 gate、runtime、scheduler 和 routes；输出不含值的安全原因码。禁止全量 dotenv 和配置写入。
6. **验证方式**：TDD 覆盖前缀隔离、引号/等号/BOM、进程覆盖、显式关闭、缺字段原因、`process.env` 不变；定向/全量门禁；独立验收；合入后精确重启并核对 2026-07-20 job trace、归档、ledger 与 outbound ledger 只增加一次正式发送。

## Design Gate 收敛

- **共识**：采用“窄读 + 安全原因日志”；同一环境快照必须贯穿 enable gate、真实 sender 与设置页。
- **否决**：只修 bat（直接 `tsx` 仍复发）；只加日志（不能恢复任务）；全量 dotenv（会把 CORS/SQLite 等配置泄入不该读取的入口）；只修 gate（会注册任务但 sender 仍可能 mock）。
- **收敛检查**：否决理由不构成新 ADR；启动配置踩坑记入本报告/F037 Timeline；不新增团队级指引。

## Verification Log

- 2026-07-20 首轮 Guardian 判 `BLOCKED`：实施计划承诺的 dotenv 行内注释未被解析；真实当前配置虽为 `smtp_ready/qq-smtp`，但未来人工注释会污染值。
- finding 经 Red→Green 修正：新增 `export`、非引号/闭引号后注释、引号内 `#` 保留与无空格注释用例，`15/16 FAIL → 16/16 PASS`；联合定向 `44/44`、typecheck、lint、build 与全仓测试通过，等待同一 Guardian 改判及 AC5 运行时证据。
- peer review 首轮判 `NO-GO`（P2=1）：server 的 disabled runtime 以 `undefined` 交接，scheduler 会重读 `.env` 并可能与 routes 分叉。新增“caller 已给 disabled boot state 不得重读”测试先 `1 read / FAIL`，再显式传递同一 `DigestBootState` 后 `0 read / PASS`；联合定向增至 `45/45`，等待 reviewer 复核。
- 最终 Guardian 复验 PASS，peer review 复核为 P1/P2/P3=0、Approved/GO；修复提交 `8fd4ef3c` 已 fast-forward 合入并推送 `dev`。
- 2026-07-20 13:34:59 +08:00 精确重启 API 后，scheduler 从旧合同 `7 cron/1 startup` 恢复为 `9 cron/2 startup`；启动任务因当时仍是 follower 留下 `skipped_not_leader` trace，13:35:59 取得 leader term 42。
- 13:38:58 仅调用一次正式 send-now 入口，13:57:47 终态 `status=ok`、`degraded=false`。当日归档生成 6 个文件，43/43 信源健康；正式收件人数 7（包含用户指定邮箱），attempt ledger 为一次、outbound ledger 精确从 35 增至 36 行，message id 已记账且未重复触发。
