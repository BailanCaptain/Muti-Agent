---
type: warning
subtype: chained_suspect
severity: warn
source: ingest-modal
detected_at: 2026-04-01T10:30:00Z
raised_by: 黄仁勋
related_room: R-001
related_drafts:
  - wiki/concepts/draft/_auto/2026-04-01-rag-deep-dive.md
  - wiki/concepts/draft/_auto/2026-04-01-rag-fine-tune.md
---

# chained_suspect — RAG deep-dive + fine-tune 同 series 未声明

两份 draft 同主题（RAG）半小时内拖入，未填 seriesId 字段。

V14 chained 检测启用后会自动 reject 第二份 promote，除非 series_id 显式标记。

**操作建议**：
- 用户在 IngestModal 填同一 seriesId (如 `rag-2026q2`)
- 跳过此 warning 不阻塞，只是提示

参考 V16.5 chap 25 line 2563-2564 series 防 chained 误检。
