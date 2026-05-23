---
type: warning
subtype: drift_detected
severity: warn
source: viewfinder
detected_at: 2026-04-10T08:45:00Z
raised_by: room-compiler
related_room: R-001
jaccard: 0.62
threshold: 0.7
---

# drift_detected — R-001 spec viewfinder 与原始 commit ledger 漂移 >30%

P12 anti-drift 检查发现 R-001 房间 viewfinder 视图与 room_decisions ledger jaccard=0.62 (低于 0.7 阈值)。

**操作建议**：
- 触发 viewfinder recompile (auto-replace 推 F028)
- 黄仁勋 review viewfinder 是否需 manual reset 到 ledger 原始 spec

参考 V16.5 chap 11 line 1186-1247 viewfinder anti-drift。
