---
name: rich-messaging
description: >
  富媒体消息：在回复正文里用 cc_rich 围栏 JSON 发只读卡片（card）和清单（checklist），前端渲染成带语义色的结构化卡片。
  Use when: review 结论、AC/验收清单、状态汇报、quality-gate 报告、长结构化汇报（回复里已有 3+ 结构化信号：列表/表格/状态字段/行动项）。
  Not for: 纯文字聊天、技术讨论、日常回复、需要用户点击交互的场景（交互卡片归 F033，还没有）。
  Output: 消息气泡内渲染出 tone 着色卡片 / 只读勾选清单。
---

# Rich Messaging（只读卡片协议 · F030）

你可以在消息正文里发声明式卡片——review 结论变绿/黄/红卡片，AC 清单变勾选视图。小孙扫一眼即得状态，不用在长 Markdown 里挖"过没过、几个 P1"。

## 发送方式（唯一通道：cc_rich 内联围栏）

在**消息正文**里写一个语言标记为 `cc_rich` 的代码围栏，内容是**单个 JSON 对象**。final 回复、post_message 进度、A2A 消息全都支持——围栏写在哪条消息里，卡片就渲染在哪条气泡里。

**先写 1-2 句自然语言，再放围栏**（卡片是摘要强化，不是上下文替代品）：

````markdown
Review 完成，结论：放行。

```cc_rich
{"id": "r1", "kind": "card", "title": "F0xx Review 通过", "tone": "success", "bodyMarkdown": "0 P1 / 0 P2，可合入。", "fields": [{"label": "P1", "value": "0"}, {"label": "P2", "value": "0"}]}
```
````

## 两种 Block

### card — 状态报告、review 结论、决策摘要

```json
{"id": "c1", "kind": "card", "title": "必填 ≤200 字", "tone": "success", "bodyMarkdown": "可选 ≤4000 字", "fields": [{"label": "≤40", "value": "≤200"}]}
```

- `tone`：`info`（默认蓝）/ `success`（绿）/ `warning`（黄）/ `danger`（红）——按结论语义选色
- `fields` 最多 12 项，放关键数字（P1 数 / AC 通过数 / 耗时）

### checklist — AC 清单、验证步骤、行动项

```json
{"id": "cl1", "kind": "checklist", "title": "可选标题", "items": [{"id": "i1", "text": "AC1 已过", "checked": true}, {"id": "i2", "text": "AC6 待小孙"}]}
```

- `items` 1-50 项；`checked` 只读展示（用户不能点——交互等 F033）
- 前端自动显示进度计数（如 `1/2`）

## 硬规则（违反 = 整段围栏降级为纯文本代码块）

1. 围栏内必须是**合法 JSON 单对象**，字段名是 `kind` 不是 `type`
2. `id` 必填且同一条消息内唯一（重复 id 只渲染第一个）
3. 围栏必须在**正文顶层**——嵌在别的代码块里不解析（marker 用 ``` 或 ~~~ 都行，本文档统一用 ```）
4. 每条消息最多 8 个 block，超出的按原文显示
5. 字段超限整块降级，**完整限制表**：

| 字段 | 限制 |
|------|------|
| `id`（block 与 item 都是） | 1-64 字符 |
| card `title` | 必填，1-200 字符 |
| card `bodyMarkdown` | ≤4000 字符 |
| card `tone` | 只认 info / success / warning / danger |
| card `fields` | ≤12 项；`label` 1-40 字符，`value` ≤200 字符 |
| checklist `title` | 可选，≤200 字符 |
| checklist `items` | 1-50 项；`text` 1-200 字符；**item `id` 必须互不重复** |

降级是 fail-closed 设计：你写错了，小孙看到的是 JSON 代码块而不是崩掉的界面。**如果你发现自己的卡片渲染成了代码块，说明被降级了——对照上表检查字段限制和 JSON 合法性，长 AC 描述（>200 字）要精简进 `text`、细节留正文。**

## 三条纪律

1. **先文字后块** — 围栏前必有 1-2 句自然语言结论
2. **不确定就纯文本** — 拿不准该不该用卡片？那就别用
3. **只读** — 不要试图让小孙"点卡片回复"；要决策用 `request_decision`，卡片只做展示

## 常见错误

| 错误 | 后果 | 正确做法 |
|------|------|----------|
| `"type": "card"` | 整块降级纯文本 | 字段是 `kind` |
| 把整篇 review 塞进 bodyMarkdown | 超 4000 字降级 | 结论进卡片，细节留正文 |
| 只发卡片不写文字 | 上下文断裂 | 先 1-2 句自然语言摘要 |
| 在 ``` 代码示例里演示 cc_rich 围栏并期望渲染 | 嵌套围栏不解析 | 演示用缩进或四反引号包裹，真发卡片写顶层 |
| 想发可点击的选择/确认 | 本协议只读 | 用 `request_decision`（结构化决策），交互卡片等 F033 |

## 和其他 skill 的区别

- `requesting-review` / `quality-gate`：那些 skill 定义**产出什么内容**；本 skill 定义**结论怎么以卡片形式发出**。review 结论 / gate 报告是 card 的头号场景。
- `request_decision`（MCP 工具）：需要小孙拍板选择时用它（阻塞等结构化响应）；卡片不能替代决策流。
