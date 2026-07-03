# 三参考库精华浓缩（design-taste 附录）

> 来源：github.com/google-labs-code/design.md · github.com/Leonxlnx/taste-skill ·
> github.com/nextlevelbuilder/ui-ux-pro-max-skill。F039 消化时的裁剪原则：只留**产品 UI
> （工具型/多面板/长时凝视）可迁移**的条款；landing page 专属花活（scroll-hijack/marquee/
> bento 营销节奏）不收。

## 一、design.md spec（DESIGN.md 文件格式合同）

- DESIGN.md = **人机共读的设计真相源**：YAML frontmatter 放机器可读 token（colors /
  typography / rounded / spacing / components，支持 `{path.to.token}` 引用），markdown
  正文放人读规则。
- 章节固定序：Overview → Colors → Typography → Layout → Elevation & Depth → Shapes →
  Components → Do's and Don'ts。可缺章不可乱序、不可重章。
- **token 是规范值，prose 是应用语境**——两边打架以 token 为准；改视觉先改这份合同。
- 我们的落地：repo 根 `DESIGN.md`（F039），token 值必须与 tailwind.config / globals.css
  实值一致（guardian 验收会抽查）。

## 二、taste-skill 可迁移条款（anti-slop 纪律）

**三旋钮心智**（我们的产品 UI 定档）：VARIANCE≈3（对称稳定）/ MOTION≈3（只做反馈性
微动效）/ DENSITY≈5（中密度工具）。营销页才拉高。

**一致性锁（原文 mandatory 级）**：
- Color Consistency Lock：一个 accent 锁全站；一套中性灰不冷暖混用
- Shape Consistency Lock：一套圆角刻度，混用必须有成文规则
- Page Theme Lock：一页一主题，禁 section 级明暗互翻

**Redesign 协议（§11，改现有 UI 必读）**：
- 先判 Preserve / Overhaul；Preserve = 审计先行（现有 token/IA/签名交互先记录再动手）
- 永不默改：路由 slug、主导航文案、表单字段名、品牌标、法务文案
- 现代化杠杆序（性价比递减）：①字体 ②间距节奏 ③色彩重校 ④动效层 ⑤关键区重组 ⑥整块替换

**AI-tells 禁令（产品 UI 适用子集）**：
- 禁纯黑 #000 / 纯白 #fff（用 off-black/off-white）；禁 neon 外发光；禁高饱和默认 accent
- 禁 Jane Doe/Acme 式假数据；禁装饰性状态圆点（点=真语义才准出现）
- 用户可见文案禁 em-dash（——句号/逗号重写）；禁"性感但语法崩"的 AI 腔文案（发货前逐句重读）
- 禁 div 拼假截图；禁手绘 SVG 图标（用图标库）

**性能护栏**：只动 transform/opacity；禁 window.addEventListener("scroll")（用
IntersectionObserver / CSS scroll-driven）；MOTION>3 必须过 prefers-reduced-motion。

## 三、ui-ux-pro-max 产品 UI 检查单（按优先级）

**P1 · A11y（CRITICAL）**：正文对比 ≥4.5:1（大字 3:1）；focus 环可见（2-4px）；
icon-only 按钮必有 aria-label；键盘 Tab 序=视觉序；label 用 for，禁 placeholder 当 label。

**P2 · 触控/交互（CRITICAL）**：点击目标 ≥44px（视觉小就扩 hit area）；按压有反馈
（80-150ms 内）；异步按钮 disable+spinner；禁 hover-only 交互。

**P3 · 性能**：50+ 项列表虚拟化；skeleton 替代 >300ms 白屏；预留尺寸防 CLS；
debounce 高频事件。

**P6 · 字与色**：正文 ≥14px 行高 1.5-1.75；字号阶梯成系统；数字列 tabular-nums；
语义色 token 化（禁组件裸 hex）；暗色≠反色（降饱和+调亮，对比单独测）。

**P7 · 动效**：150-300ms；enter ease-out / exit ease-in（exit 比 enter 短）；
列表 stagger 30-50ms；动效必须可被打断、不挡输入。

**P8 · 表单/反馈**：错误贴字段下方+给恢复路径；破坏性操作确认+红系+空间隔离；
toast 3-5s 自消失+aria-live=polite；成功要有确认反馈。

**P9 · 导航**：当前位置高亮；返回可预期（保滚动位/筛选态）；图标+文字双标；
危险动作与常规导航空间隔离。

## 四、F039 实战新增（三库没有、我们踩出来的）

- **config 级 hue 家族重映射**：改全站色的正确姿势——tailwind.config 里把股票家族
  整族映射为 OKLCH 派生 hex 阶 + 别名收敛，类名零改动（642 处一次生效、测试不破）。
  hex 落值是为保 opacity 修饰符；var(oklch) + opacity 修饰符会**静默失效**。
- **identity ≠ status 分族**：agent 身份色（violet/amber/teal）只标"归属"，
  状态判断（成败警告）只用状态族；amber 双职靠场景区分。
- **量化审计先行**："丑"拆成可 grep 的债务清单（裸色数/任意字号数/focus 覆盖率/
  emoji 图标数），改前立基线、改后归零复扫——这让"好看"变成可验收的 AC。
- **色阶生成器进仓**（`scripts/design/gen-color-scales.mjs`）：Ottosson OKLab 数学 +
  sRGB gamut 二分收敛 + WCAG 对比自检输出，换 hue/chroma 可复现整族。
