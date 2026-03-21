---
name: merge-approval-gate
description: 当准备合入 main、合并 PR、提交最终版本时触发。强制检查 reviewer 是否已明确放行。
---
# Core Principle

作者不能作为自己修复是否正确的最终裁判。
合入前必须有明确、无条件的 reviewer 放行信号。

## 检查流程

BEFORE 合入 main / merge PR:
1. CHECK: 是否存在 reviewer 的明确放行语句
   - “可以放行了”
   - “LGTM”
   - “通过”
   - “Approved”
2. CHECK: reviewer 是否仍保留未解决的 P1/P2
3. CHECK: 最近一次修复后，是否已经回给 reviewer 复核
4. BLOCK: 如果只是作者自己认为“应该改对了”，禁止合入
5. BLOCK: 如果 reviewer 说的是条件式认可，禁止合入
   - “整体 OK，但 XXX 要改”
   - “只剩一点小问题”
   - “差不多了”
6. PASS: 只有明确放行，才允许 merge

## 执行动作

IF 没有明确放行:
- 当前不能合入
- 缺少 reviewer 明确批准
- 下一步应把修复结果回给 reviewer，等待明确放行语句

IF 已有明确放行:
- 已满足 merge gate
- 可以合入
