---
type: warning
subtype: acl_violation
severity: high
source: promote-modal
detected_at: 2026-04-03T14:22:00Z
raised_by: 桂芬
related_path: wiki/rules/iron-laws.md
---

# acl_violation — Iron Laws path 写权限拒绝

桂芬尝试 promote draft 到 `wiki/rules/iron-laws.md`，被 DEFAULT_ACL_YAML 规则拒绝（rules/** 只允许 promote alias = 黄仁勋 / 小孙）。

**操作建议**：
- 由黄仁勋或小孙手动 review 并 promote
- 桂芬继续维护 draft

参考 packages/api/src/wiki/wiki-services.ts DEFAULT_ACL_YAML。
