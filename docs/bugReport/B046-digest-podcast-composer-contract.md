---
id: B046
title: F037 播客 Composer 合同冲突导致日报停发
status: fixed
reported_by: 小孙
reported_at: 2026-07-28
related: F037, B027, B032, B045
---

# B046 — F037 播客 Composer 合同冲突导致日报停发

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **Bug 现象** | 2026-07-28 日报多次完成 43 路信源抓取与编辑审核，却都以 `digest-composer invalid structured output` 停止，7 位配置收件人无人收到邮件。 |
| 2 | **证据** | 10:48 Codex Composer 原稿是合法 JSON，共 37 个获批输入、6 条 overview、4 个栏目；唯一违规是把 3 条播客写进 `podcast.picks`。解析器配置 `podcast picks=0`，却因先 push 后检查而保留第 1 条、裁掉第 2/3 条；overview 仍引用后两条，最终因引用不在发布集合而整稿拒绝。07:40、08:20、09:22、10:21、10:48 五稿同样复现。 |
| 3 | **根因** | Composer 通用 schema 允许所有栏目写 `picks`，提示词未声明播客只能写 `briefItemIds`；服务端 list-only 合同与模型合同不一致，并叠加零上限 off-by-one。 |
| 4 | **修复** | 对已通过 ID/category/text 护栏的 podcast primary pick 做服务端规范化：只保留主 itemId，写入最多 4 条 `briefItemIds`，不隐式放行 `alsoItemIds`；同时在 prompt 明确 `podcast.picks=[]`。严格保留 overview 必须锚定最终 publication 的门禁。 |
| 5 | **预警策略** | 不记录模型原始正文到运行日志，不放宽幽灵 ID、跨栏目、URL、AI 双侧覆盖或 overview 发布闭合门禁；发送前再次检查当日 ledger 与 outbound 计数，确保只补发一次。 |
| 6 | **复现验收** | 用 2 条 AI + 3 条播客构造今日同形 Composer 稿：修前 `summarize=null`；修后播客 `picks=[]`、3 个 ID 全在 `briefItemIds`、5 条 overview 保持闭合，publication 角色为 list。 |

## 原始反馈

> “为啥今天没有收到日报，是你这个代码没合入，没帮我重启项目吗？”
>
> “需要给所有人补发 因为现在没有1个人收到”

## 验证方式

1. 运行 B046 target-aware Composer 回归测试，确认旧现象先红后绿。
2. 运行日报摘要专项测试、API typecheck、lint 与全量测试。
3. 合入并重启后只触发一次全员补发。
4. 验证 `ledger/2026-07-28.json`、归档文件、SMTP/outbound 账本仅新增一条，最终状态为 `ok`。
