# B046 播客 Composer 合同修复计划

1. **RED**：复现合法 JSON 中 3 条播客误写 `picks`、overview 引用后两条而整稿失败。
2. **GREEN**：将通过既有护栏的 podcast primary pick 规范化为最多 4 条 `briefItemIds`；修复零上限 push 次序。
3. **合同锁定**：提示词明确 podcast `picks=[]`、overview 播客引用必须同时进入 `briefItemIds`。
4. **回归**：验证 ghost、跨 category、重复、上限与 `alsoItemIds` 不隐式放行；运行摘要专项、typecheck、lint、全量测试。
5. **交付**：独立验收与 review 放行后合入 `dev`、重启 API/Web；确认当日未发送后仅补发一次给完整收件人 allowlist。
6. **终态证据**：确认 2026-07-28 ledger、归档、source health、outbound 只新增一条且发送状态为 `ok`。
