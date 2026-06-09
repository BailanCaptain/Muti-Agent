---
type: warning
subtype: quota_exhausted
severity: critical
source: adaptive-recall
detected_at: 2026-04-20T22:18:00Z
raised_by: AdaptiveRecallCoordinator
related_model: claude-sonnet-4-6
quota_kind: oauth
fallback_model: claude-haiku-4-5
---

# quota_exhausted — Sonnet 4.6 OAuth quota 用尽，fallback Haiku 4.5

LlmCritiqueAgent 调 Sonnet 4.6 时返 429 quota_exceeded，自动 fallback 到 Haiku 4.5。

按 plan AC-P4-8 a 决议：fallback 不等价 PASS，AC-P4-5 evidence pack 应记 verdict=BLOCKED + blocked_reason="quota_exhausted_fallback"。

**操作建议**：
- 小孙看 Anthropic console 查 quota 上限是否需提升
- 24h 内 evidence pack 该 AC verdict 标 BLOCKED

参考 plan AC-P4-8 a + feedback codex_judge2_finds_real_gaps。
