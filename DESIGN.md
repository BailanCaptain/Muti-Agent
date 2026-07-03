---
version: alpha
name: Multi-Agent Warm Workspace
description: >
  Multi-Agent 协作工作台的设计真相源（F036 奠基 + F039 收束）。
  格式遵循 github.com/google-labs-code/design.md spec：frontmatter 是机器可读 token，
  正文是人机共读的应用规则。改视觉先改这里与 tailwind.config.ts / app/globals.css，禁止在组件里造色。
colors:
  # 品牌交互色（暖金/陶土，oklch(0.55 0.14 50)）—— 唯一"行动"色
  accent: "oklch(0.55 0.14 50)"
  accent-hover: "oklch(0.45 0.14 50)"
  # 4 档表面（warm beige，hue 80；越亮越"近"，聊天主区最亮）
  surface-sunken: "oklch(0.92 0.015 80)"
  surface: "oklch(0.95 0.012 80)"
  surface-elevated: "oklch(0.99 0.005 80)"
  surface-canvas: "oklch(0.995 0.003 80)"
  # 暖中性（hue 30 / chroma 0.005，Tailwind slate 全站重映射）
  neutral-50: "#fbfaf9"
  neutral-300: "#d1cec9"
  neutral-500: "#75726e"
  neutral-700: "#494744"
  neutral-900: "#242220"
  # 语义状态（共享 L ramp × 家族 hue；完整 11 档见 tailwind.config.ts）
  critical: "#b14f42"
  success: "#448247"
  warning: "#966800"
  info: "#287aa3"
  # 三 agent 身份色（500 档；identity ≠ status，见正文）
  identity-claude: "#7763ab"
  identity-codex: "#966800"
  identity-gemini: "#008479"
typography:
  body:
    fontFamily: Inter / Noto Sans SC
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  compact:
    fontFamily: Inter / Noto Sans SC
    fontSize: 13px
    fontWeight: 400
    lineHeight: 19px
  label:
    fontFamily: Inter / Noto Sans SC
    fontSize: 12px
    fontWeight: 500
    lineHeight: 16px
  caption:
    fontFamily: Inter / Noto Sans SC
    fontSize: 11px
    fontWeight: 400
    lineHeight: 15px
  micro:
    fontFamily: Inter / Noto Sans SC
    fontSize: 10px
    fontWeight: 500
    lineHeight: 14px
  code:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.6
rounded:
  field: 12px
  card: 16px
  panel: 20px
  floating: 24px
  full: 9999px
spacing:
  base: 4px
  gap-inline: 8px
  gap-block: 12px
  card-padding: 14px
  panel-padding: 16px
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.field}"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  input-field:
    backgroundColor: "{colors.surface-canvas}"
    rounded: "{rounded.field}"
  card:
    backgroundColor: "{colors.surface-canvas}"
    rounded: "{rounded.card}"
---

# Multi-Agent 设计真相源

## Overview

三人 AI 团队（黄仁勋 / 范德彪 / 桂芬）+ 小孙的协作工作台。气质对标 claude.ai 的暖中性：
**专注、温和、可长时间凝视**。不是营销页，是每天泡 8 小时的工具——克制大于炫技。
密度中等（VISUAL_DENSITY≈5）、动效低（MOTION_INTENSITY≈3，只做反馈性微动效）、
布局对称稳定（DESIGN_VARIANCE≈3）。light-only（暗色模式属 backlog，做之前双模一起设计）。

## Colors

一切颜色从三个真相源出：`app/globals.css`（oklch 变量）、`tailwind.config.ts`（hex 落值色阶）、本文件（语义声明）。

- **Accent（暖金/陶土）**是唯一"行动"色：主 CTA、链接、焦点环、拖拽高亮、选中态。一屏一个主行动。
- **表面 4 档**做层次（sunken 凹槽 < surface 侧栏 < elevated 聊天主区 < canvas 浮起卡片），
  平面之间靠表面档位区分，不靠投影。
- **状态色 4 族**（critical/success/warning/info = red/green/amber/blue 家族）：全部由
  `scripts/design/gen-color-scales.mjs` 从共享 L ramp 生成，600-on-50 对比 ≥6.5、500-on-white ≥4.5（AA）。
- **身份色 3 族**（claude=violet / codex=amber / gemini=teal）：**identity ≠ status**。
  身份色只出现在"这段话/这张卡属于谁"的场景（气泡边、身份条、@ pill、配置面板 focus）；
  状态判断（成功/失败/警告）永远用状态族。amber 双职（warning + codex）靠场景区分。
- **别名收敛**：emerald/lime≡green、rose≡red、orange/yellow≡amber、sky≡blue、cyan≡teal、
  indigo/purple/fuchsia≡violet——写哪个类名渲染都一样，新代码请直接写主族名。

## Typography

拉丁 Inter + 中文 Noto Sans SC（next/font 自托管 + head link），代码 JetBrains Mono。

- 字阶：`micro(10) < caption(11) < xs(12) < compact(13) < sm(14) < base(16) < lg+`。
  **10px 是下限**——任何比它小的字都是错的。禁止 `text-[Npx]`（N≤16）任意值。
- 层级靠字重（400 正文 / 500 标签 / 600-700 标题）+ 颜色（neutral-900/600/500 三档），不靠猛加字号。
- 数字列（token 计数、进度）用 `font-mono` + `tabular-nums` 防抖动。

## Layout

- 三栏：左会话列表（surface）+ 中聊天（elevated，最亮）+ 右观测面板（surface）。
- 4px 基线网格；组件内 gap 8px、块间 12px、卡片内边距 14px、面板 16px。
- 聊天主区内容 max-width 980px 居中；时间线虚拟化（@tanstack/react-virtual）。

## Elevation & Depth

层次优先靠**表面档位**，投影只给真浮层：

- `shadow-sm`（elevation-1）：卡片 hover、轻浮起。
- `shadow-md`（elevation-2）：下拉、popover。
- `shadow-lg`（elevation-3）：模态、抽屉。
- `shadow-glow`：主 CTA 专属暖金光晕（accent 同源）。
- 禁止冷黑投影（rgba(15,23,42,…) 是股票 slate 残留，用 rgba(36,34,32,…) 或 elevation token）。

## Shapes

4 档语义圆角，按容器层级取用：`field(12) 输入/按钮/chip → card(16) 卡片/列表项 →
panel(20) 抽屉/面板/composer → floating(24) 最外浮层`。禁止 `rounded-[Npx]` 任意值。
例外：provider-avatar 的 10/22/32px squircle 阶梯是独立视觉语言，不纳入本刻度。

## Components

- **按钮**：主 CTA = accent-500 底白字 + `hover:accent-600` + `active:scale-[0.97]`（按压反馈必有）；
  危险动作 = red 族；次要 = 白底 slate 边。禁用态 = slate-200 底、去投影。
- **输入**：canvas 底 + slate-200 边 + `focus:border-accent-400`；label 在上、错误在下，禁 placeholder 当 label。
- **图标**：lucide-react 一个家族，尺寸贴字阶（text-xs 旁 3.5、micro/caption 旁 3）。
  **emoji 不当结构图标**（设置/删除/状态请用 lucide）；emoji 只允许两处：agent 身份头像、消息正文内容。
- **焦点**：全局 `:focus-visible` 2px accent 环（globals.css）。**禁止裸 `outline-none`**——
  杀环必须同时给 `focus:` / `focus-visible:` 替代样式。
- **加载/空态**：>300ms 的加载给 skeleton（animate-pulse 灰块，形状贴最终布局），不给光杆"加载中…"文字；
  空态要"教下一步"（参考 timeline-welcome：名册 + @ 用法），不给一行斜体。
- **动效**：150-300ms、只动 transform/opacity；装饰性循环动画必须过 `prefers-reduced-motion` 降级
  （globals.css 已兜 breathe/approval-pulse）。

## Do's and Don'ts

- Do：改色改字改圆角先来本文件 + tailwind.config / globals.css；组件里只写语义 token 类。
- Do：新状态 UI 先问"这是状态还是身份"，再选色族。
- Don't：**accent-\*/surface-\* 类禁止带 opacity 修饰符**（`accent-500/60` 会静默失效——oklch var 坑，F036 实踩）；
  状态/身份族是 hex，可以带。
- Don't：不引第二个图标库、不手绘 SVG 图标、不用纯 #000/#fff（用 neutral-950/canvas）。
- Don't：用户可见文案禁用 em-dash（——用句号/逗号/顿号重写）；内部注释不限。
- Don't：不在组件里写裸 hex/rgba 颜色（唯一豁免：本文件登记过的 squircle 阶梯与 glow 同源值）。
