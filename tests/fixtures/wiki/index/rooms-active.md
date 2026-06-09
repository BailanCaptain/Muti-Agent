---
type: index_view
bucket: rooms-active
generated_at: 2026-05-23T00:00:00Z
compiler_version: 1.0.0
threshold_days: 30
---

# wiki/index/rooms-active.md — 活跃房间派生视图（30 日内有 message 写入）

| room_id | members | last_active_at | message_count | decision_count |
|---|---|---|---|---|
| R-001 | 黄仁勋 / 小孙 / 范德彪 / 桂芬 | 2026-05-23T22:00:00Z | 1850 | 32 |
| R-007 | 小孙 / 黄仁勋 | 2026-05-20T11:45:00Z | 340 | 8 |
| R-019 | 黄仁勋 / 桂芬 | 2026-05-18T14:30:00Z | 215 | 5 |

派生自 `session_groups` + `room_messages` 按 30 天活跃阈值 — fixture seed Phase 4 Week 4 Day 16。
归档房间见 `wiki/index/rooms-archive.md`。
