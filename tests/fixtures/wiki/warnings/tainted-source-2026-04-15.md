---
type: warning
subtype: tainted_source
severity: high
source: v14-promote-audit
detected_at: 2026-04-15T11:00:00Z
raised_by: V14PromoteAuditService
related_draft: wiki/concepts/draft/_auto/2026-04-15-bad-quote.md
audit_layer: tainted_source_direct_quote
matched_patterns:
  - "system: "
  - "你必须"
---

# tainted_source — draft body 直引 tainted_source 字段未改写

draft body 含原文 `system: ...` 段 + 命令式语句 "你必须..." 直接复制自 IngestModal 拖入的 file (tainted_source)。

V14 二次审计 layer 3 (tainted_source_direct_quote) reject 此 promote。

**操作建议**：
- 用户改写 draft body 为陈述句（"该 prompt 包含 system 段..." 而非直引）
- 重新 promote (V14 自动 re-audit)

参考 V16.5 chap 14 line 838-846 V14 二次审计。
