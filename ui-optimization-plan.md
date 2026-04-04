# UI 优化方案 - 桂芬 (Multi-Agent)

## 任务目标
参考 `clowder-ai` 项目的 UI 实现，优化当前项目的视觉体验。铁律：不新增功能，只优化现有功能，并删除前端未实现的内容。

## 1. 语言与格式 (Localization)
- 将所有前端 UI 标签从英文翻译为中文，遵循 `GEMINI.md` 的强制要求。
- 示例：
  - `Inner Thoughts` -> `深度思考`
  - `Control Panel` -> `控制面板`
  - `Status Board` -> `状态看板`
  - `Room Health` -> `房间健康度`
  - `Message Stats` -> `消息统计`
  - `Agent Config` -> `智能体配置`
  - `Session Chain` -> `会话链`
  - `Model` -> `模型`
  - `Save` -> `保存`

## 2. 视觉一致性 (Color Consistency)
- 统一 Provider 的颜色映射，解决当前组件间颜色不一致的问题。
  - **Claude (范德彪):** 紫色/紫罗兰色 (`violet`)
  - **Codex (黄仁勋):** 琥珀色/橙色 (`amber`)
  - **Gemini (桂芬):** 天蓝色/青色 (`sky` 或 `cyan`)
- 在 `provider-avatar.tsx`, `status-panel.tsx`, `composer.tsx` 和 `message-bubble.tsx` 中应用一致的颜色。

## 3. 消息气泡优化 (Message Bubble Optimization)
- **深度思考 (Thinking) 块:**
  - 根据 Provider 的主色调，为思考块提供带有透明度的背景色 (Tinted backgrounds)。
  - 增加展开/收起的平滑动画效果。
  - 标签翻译为 "深度思考"。
- **布局微调:**
  - 优化气泡的阴影和圆角，使其更符合 `clowder-ai` 的精致感。

## 4. 清理未实现内容 (Cleanup Unimplemented Content)
- **ChatHeader:** 删除导出、广播、布局、移动端预览等无功能按钮。
- **StatusPanel:** 删除无功能的设置 (Settings) 按钮。
- **清理 Mock 数据:** 优化 `StatusPanel` 中的启发式统计计数器，仅显示目前真正支持的内容。

## 5. 整体风格提升
- 在 `page.tsx` 中优化背景渐变，使其更加细腻。
- 改进 `ChatHeader` 的 PawPrint 标志，增加一些呼吸感。

## 执行步骤
1. 进入 worktree: `ui-optimization-guifen`
2. 修改 `components/chat/provider-avatar.tsx` 统一颜色主题。
3. 修改 `components/chat/message-bubble.tsx` 实现 Provider 特有的思考块。
4. 修改 `components/chat/status-panel.tsx` 进行汉化及清理。
5. 修改 `components/chat/chat-header.tsx` 清理冗余按钮。
6. 修改 `components/chat/composer.tsx` 进行汉化及颜色统一。
7. 修改 `app/page.tsx` 优化整体视觉背景。
8. 进行回归测试，确保无功能损失。
