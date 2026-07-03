---
name: design-taste
description: >
  前端视觉工作纪律：token 真相源 + 量化审计 + 一致性锁 + 状态全周期（F036/F039 实战沉淀，
  精华取 google-labs-code/design.md、Leonxlnx/taste-skill、nextlevelbuilder/ui-ux-pro-max）。
  Use when: 改前端视觉/样式、新组件 UI、restyle/打磨、小孙嫌丑/"不够好看"、选色/字号/圆角/动效。
  Not for: 布局 IA 重构（走 feat-lifecycle Design Gate）、纯逻辑改动、视觉最终裁决（小孙人眼）。
  Output: 对标 DESIGN.md 的合规改动 + 量化审计前后对比 + 截图证据。
---

# Design Taste — 前端视觉纪律

F039 沉淀。核心洞察：**"丑"不是玄学，是可以 grep 出来的**——散装色、散装字号、缺失的
交互状态各有量化指标；修法也不是逐处改，而是 token 层一次收编。

## 铁律：真相源优先

**改视觉先读 repo 根 `DESIGN.md`**（design.md spec 格式：frontmatter tokens + 8 章规则）。
三层真相源，改哪层看范围：

| 层 | 文件 | 管什么 |
|----|------|--------|
| 语义合同 | `DESIGN.md` | 品牌气质 / identity≠status / Do's & Don'ts |
| 色与阶 | `tailwind.config.ts` | hue 家族 hex 阶 / 字阶 / 圆角 4 档 / shadow token |
| 变量与基线 | `app/globals.css` | OKLCH 变量 / focus-visible / reduced-motion |

**组件里只写语义 token 类，禁裸 hex/rgba/任意值**（豁免区在 DESIGN.md 登记：avatar squircle 阶梯、glow 同源值）。

## 流程

1. **判模式**（taste-skill §11）：Preserve（演化，默认）/ Overhaul / Greenfield。
   Preserve 红线：不动 IA、路由、nav 文案、埋点锚点。
2. **量化审计**（改前跑，改后复扫归零）：
   ```bash
   # 裸色（应走 token）            # 任意字号（应走字阶）
   grep -rEo "(text|bg|border|ring)-(red|green|blue|...)-[0-9]+" components/ | wc -l
   grep -rEo "text-\[[0-9.]+px\]" components/ | sort | uniq -c
   # 焦点环覆盖 / emoji 当图标 / 硬编码色 / transition 散装
   grep -rl "focus-visible" components/ | wc -l ; grep -rn "outline-none" ...
   grep -rn "⚙️\|📋\|✅\|❌..." --include="*.tsx" ; grep -rEn "#[0-9a-fA-F]{6}|rgba\(" ...
   ```
3. **改法按杠杆序**（性价比递减）：字体/字阶 → 间距节奏 → 色彩收编 → 微动效 → 关键区重组。
4. **全站换色用 config 重映射，不逐处改类名**：在 tailwind.config 把 hue 家族重映射为
   OKLCH 派生 hex 阶（生成器 `scripts/design/gen-color-scales.mjs`，共享 L ramp × 家族 hue）
   + 别名收敛（emerald≡green 等）。类名零改动 → 测试不破、opacity 修饰符保活、N 处一次生效。
5. **验证**：生成器自带 WCAG 对比自检（600-on-50≥4.5）；Tab 走查焦点环；playwright 截图
   （多状态：空房间/聚焦/各 tab）；有交互改动走 `webapp-testing`。

## 一致性锁（四把，违反即打回）

1. **一个 accent**：一屏一个主行动色；状态判断用状态族（red/green/amber/blue），
   身份标识用身份族（violet/amber/teal）——**identity ≠ status**，别混。
2. **一套圆角**：field(12)/card(16)/panel(20)/floating(24)，禁 `rounded-[Npx]`。
3. **一个图标家族**：lucide，尺寸贴字阶；**emoji 只允许两处**——agent 身份头像、消息正文。
4. **一个主题**：light-only 锁定；暗色要做就双模一起设计，不做半吊子。

## 状态全周期（每个界面四问）

- Loading >300ms → `SkeletonLines`（形状贴布局），不给光杆"加载中…"文字
- 空态 → 教下一步（参考 timeline-welcome 名册卡），不给一行斜体
- 错误 → 给恢复路径（重试/说明），inline 优先
- 按压 → 主 CTA `active:scale-[0.97]`；动效 150-300ms 只动 transform/opacity + reduced-motion 降级

## 铁坑（实战踩过，禁复发）

| 坑 | 后果 | 正解 |
|----|------|------|
| `accent-500/60` 等 var(oklch)+opacity 修饰符 | 静默失效渲染全不透明 | oklch var 只用实色；要 opacity 用 hex 族 |
| radius token 叫 `xl` | 撞内置 rounded-xl 静默改写全站 | 用非内置名（floating） |
| 全局重映射前不查 hue 语义 | 合并掉刻意区分（如 gemini sky vs teal） | 先 grep 每族用途，身份/状态分道 |
| 8/9px 字号 | 低于可读下限 | 10px 是地板（micro 档） |
| 杀 outline-none 不给替代 | 键盘用户失明 | focus-visible: 替代或邻元素 affordance |

## 和其他 skill 的区别

- `webapp-testing`：交互行为验证（真点击）——本 skill 管视觉质量与 token 纪律
- `feat-lifecycle` Design Gate：新 UI 方向要小孙拍——本 skill 管拍完之后怎么做不走样
- 视觉美学终审：小孙人眼（本 skill 让你走到"值得他看"的水位）

## 下一步

改动完成 → `quality-gate`（前端专项：浏览器实操 + 截图为证）→ 三库可迁移条款速查见
同目录 `reference-distillation.md`。
