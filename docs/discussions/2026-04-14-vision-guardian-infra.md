# 2026-04-14 愿景守护基础设施讨论

## 背景

小孙提出愿景守护流程完全没用：前端看不了图、后端得重启服务手动验证、代码仓没有日志。
要求参考 reference-code（clowder-ai / deer-flow / OpenHarness）三个最佳实践寻找解决方案。

## 参与者

黄仁勋、范德彪、桂芬

## 讨论模式

Phase 1: 并行独立思考 → Phase 2: 串行讨论（2轮）

## 根因共识

愿景守护"没用"不是概念问题，是证据通道缺失 + 开发回路原始：
- 全验证链（quality-gate → acceptance-guardian → code-review → merge-gate）都是文本自证
- BlockRenderer 只认 markdown/thinking/card/diff，协议层没把图片当一等内容
- dev:api 用 tsc + node dist/，没有 watch mode
- 应用层 49 个 catch 块静默吞错，WebSocket/Agent调度全黑盒

## 关键决策

1. **图片走 ContentBlock，不绑 ToolEvent**（范德彪提出，全员同意）
2. **传输层先兼容 base64 做 PoC，长期走 URL 引用**（范德彪提出）
3. **先建证据链不上阻断**（方案 C）（黄仁勋提出，全员同意）
4. **截图必须带元信息**：source/timestamp/viewport（范德彪提出）
5. **Skill 热更新单独立项**，不混入本次修复（黄仁勋提出）
6. **截图方案改用 clowder-ai 的 bridge script 模式**，不上 Playwright（黄仁勋诊断后更新）

## 立项结论

立为 F008，四层修复：P0 hot-reload → P1 图片一等公民 → P1.5 结构化日志 → P2 截图+用户发图
