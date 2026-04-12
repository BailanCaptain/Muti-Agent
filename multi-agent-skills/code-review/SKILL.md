---
name: code-review
description: >
  严格代码审查：聚焦 bug、风险、行为回归、边界条件和缺失测试。
  Use when: 用户要求 review 代码、审查 diff/PR/提交、做 peer review。
  Not for: 请求别人 review（用 requesting-review）、收到 review 反馈后修复（用 receiving-review）、纯自检（用 quality-gate）。
  Output: 按严重度排序的 findings + open questions + residual risk。
---

# Code Review

代码审查的目标不是给建议清单，而是找出**会出事的地方**。

## 审查优先级

先找这些，再考虑风格：

1. 真实 bug
2. 行为回归
3. 边界条件缺失
4. 数据一致性 / 并发 / 状态机问题
5. 安全与权限问题
6. 缺失测试

没有明确风险时，不要为了"给点意见"而制造噪音。

## 审查流程

1. 先看改动范围：哪些文件、哪些行为被改了
2. 对照上下文：原实现为什么这样写，当前改动会不会打破它
3. 优先沿用户路径和失败路径走一遍
4. 检查测试：
   - 改动覆盖到了吗
   - 失败路径和边界情况有吗
   - 只测 happy path 吗
5. 输出 findings：
   - 必须带文件 / 行号
   - 必须说明为什么是问题
   - 能说明用户影响就说明用户影响

## 输出格式

先列 findings，按严重度排序：

```markdown
1. [severity] 问题标题 — `path/to/file.ts:123`
   为什么有问题：...
   影响：...
   建议：...
```

然后再写：

- Open questions
- Residual risk / testing gaps

如果没有发现问题，明确写：

```markdown
未发现明确 bug / 回归风险。
残余风险：{没跑到的测试、没验证到的平台、需要人工确认的点}
```

## 严重度标准

- `P0`：会导致数据损坏、权限突破、系统不可用
- `P1`：核心功能错误、明显回归、会在真实使用中出问题
- `P2`：边界条件、稳定性、可维护性问题，建议当前迭代修
- `P3`：非阻塞优化项，可讨论

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 把风格建议放在前面 | findings 先讲 bug / 风险 |
| 只说"这里不太好" | 说明具体机制和影响 |
| 没文件位置 | 每个 finding 都带文件 / 行号 |
| 没看测试就评审 | 测试覆盖本身就是审查对象 |
| 没发现问题却硬凑建议 | 明确说无 findings，再写残余风险 |
