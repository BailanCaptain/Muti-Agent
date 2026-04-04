---
name: receiving-review
description: 当收到 reviewer 的反馈，需要修复问题或回应 review 意见时触发。禁止表演性同意，必须先证明理解，再行动。
---
# Core Principle

收到 review 后，最重要的不是礼貌回应，而是证明自己理解了问题。
行动、复述、澄清，比“感谢反馈”更有价值。

## 检查流程

AFTER 收到 review:
1. CHECK: 是否真正理解 reviewer 指出的技术问题
2. CHECK: 是否能复述问题的机制、影响和修复方向
3. CHECK: 如果不确定，是否主动提出澄清问题
4. BLOCK: 禁止表演性同意
   - “You're absolutely right!”
   - “Great point!”
   - “Excellent feedback!”
   - “Thanks for catching that!”
   - “我马上改”
5. PASS: 只有在“复述问题 / 提问澄清 / 给出修复方案”之一成立时，才算有效回应

## 响应格式

### Review Response
- Understanding:
- Fix Plan:
- Questions:
- Status:

## 修复后的回传格式

### Fix Update
- What Changed:
- Why This Fix Addresses It:
- Remaining Risk:
- Request:
  请 reviewer 复核并明确放行 / 不放行

## 通过场景

### 正例
### Review Response
- Understanding:
  范德彪指出的是 `saveConversation()` 这段仍然存在 lost update。虽然我加了本地锁，但锁只在单实例内有效，多个 worker 仍可能并发写同一份状态。
- Fix Plan:
  我会把这段改成版本校验写入，并补一个冲突重试测试。
- Questions:
  如果版本冲突超过重试上限，你更倾向返回错误还是降级成队列串行化？
- Status:
  正在修复

### Fix Update
- What Changed:
  我把 `saveConversation()` 改成 `load(version) -> compareAndSet -> retry`，并新增了 2 个测试覆盖冲突重试和重试失败。
- Why This Fix Addresses It:
  之前的问题是多 worker 并发写没有全局版本保护。现在每次写都校验版本，冲突时不会静默覆盖旧值。
- Remaining Risk:
  重试策略还是固定次数，没有退避。
- Request:
  请范德彪复核这次修复，并明确回复是否可以放行。
