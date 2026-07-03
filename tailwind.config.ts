import type { Config } from "tailwindcss";

// ============================================================
// F039 状态/身份色暖调和 —— OKLCH 派生调和阶（生成器: scripts/design/gen-color-scales.mjs）
// 打法同 F036 slate：类名零改动、hex 落值保留 `red-200/60` 这类 opacity-modifier
// （var(oklch) + opacity 修饰符会静默失效——F036 已踩）。
// 共享 L ramp（对齐 accent 阶）× 家族 hue/chroma：
//   red h30(critical) / amber h78(warning+codex) / green h145(success)
//   teal h185(gemini) / blue h235(info) / violet h295(claude)
// 16 个股票 hue 家族收敛为 6 家 + alias（emerald/lime→green、rose→red、
// orange/yellow→amber、sky→blue、cyan→teal、indigo/purple/fuchsia→violet），
// 消灭"同一语义两种绿 / 冷调状态色打架"的股票 Tailwind 残留。
// 对比度实测（generator 输出）：各家 600-on-50 ≥6.5、500-on-white ≥4.5（AA）。
// ============================================================
const red = {
  50: "#fff2ef",
  100: "#ffe4df",
  200: "#ffc9bf",
  300: "#eca295",
  400: "#cd7264",
  500: "#b14f42",
  600: "#8f3126",
  700: "#6e1c13",
  800: "#490d07",
  900: "#2d0604",
  950: "#150101"
};
const amber = {
  50: "#fff3e2",
  100: "#fae9cf",
  200: "#f0d3a8",
  300: "#d8b073",
  400: "#b6852e",
  500: "#966800",
  600: "#714d00",
  700: "#523700",
  800: "#352200",
  900: "#201300",
  950: "#0d0600"
};
const green = {
  50: "#ecf9ec",
  100: "#def1de",
  200: "#c2e2c2",
  300: "#99c599",
  400: "#679f69",
  500: "#448247",
  600: "#26652b",
  700: "#114a18",
  800: "#06300b",
  900: "#031c05",
  950: "#000b01"
};
const teal = {
  50: "#e7faf7",
  100: "#d6f2ee",
  200: "#b3e3dc",
  300: "#83c6bd",
  400: "#43a196",
  500: "#008479",
  600: "#00635b",
  700: "#004841",
  800: "#002e29",
  900: "#001b18",
  950: "#000a08"
};
const blue = {
  50: "#ebf7ff",
  100: "#d9effd",
  200: "#b9def4",
  300: "#8bbfde",
  400: "#5498be",
  500: "#287aa3",
  600: "#005d82",
  700: "#00435f",
  800: "#002a3e",
  900: "#001927",
  950: "#000911"
};
const violet = {
  50: "#f6f3ff",
  100: "#ece7ff",
  200: "#d9d1f9",
  300: "#baaee4",
  400: "#9383c5",
  500: "#7763ab",
  600: "#5a478b",
  700: "#42306b",
  800: "#2a1d47",
  900: "#18102c",
  950: "#090415"
};

// F036 暖中性（OKLCH hue 30 / chroma 0.005 → hex）。
// 500 档从 #7d7a76(对比 4.27) 微调暗到过 AA 4.5:1（白底实算 ~4.79）——
// 10-12px 次要文本(时间戳/说明)在 elevated/canvas 上可读（F036 codex-r1 P2）。
const warmSlate = {
  50: "#fbfaf9",
  100: "#f4f2f0",
  200: "#e8e5e2",
  300: "#d1cec9",
  400: "#aaa6a1",
  500: "#75726e",
  600: "#605d59",
  700: "#494744",
  800: "#343230",
  900: "#242220",
  950: "#161513"
};

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Segoe UI", "sans-serif"],
        mono: ["var(--font-mono)", "SFMono-Regular", "Consolas", "monospace"]
      },
      fontSize: {
        // F039 字阶 token（补内置 xs/sm/base 之下的 UI 微字号档）：
        // micro 10px 徽标/计数器（8/9px 低于可读下限，全部升到此档）
        // caption 11px 时间戳/次要 meta；compact 13px 紧凑正文（表单/面板）
        // 全库 text-[Npx]（N≤16）任意值 snap 到这三档 + 内置档，display 级大数字保留任意值。
        micro: ["10px", { lineHeight: "14px" }],
        caption: ["11px", { lineHeight: "15px" }],
        compact: ["13px", { lineHeight: "19px" }]
      },
      colors: {
        // F036 restyle（移植 clowder neutral）：slate 全站重映射成"几乎不带色的暖灰"
        // （OKLCH hue 30 / chroma 0.005 → hex），一处生效全站去"股票 Tailwind 冷蓝脸"。
        // 用 hex 而非 var() 是为了保留 `slate-200/60` 这类 opacity-modifier。
        // F039: gray/zinc/stone 同源收编（F036 只重映射了 slate，这三家曾是股票冷灰残留）。
        slate: warmSlate,
        gray: warmSlate,
        zinc: warmSlate,
        stone: warmSlate,
        // 4 档表面（吃 globals.css 的 OKLCH token）——给 bg-surface / bg-elevated / bg-canvas / bg-sunken
        surface: {
          DEFAULT: "var(--surface)",
          sunken: "var(--surface-sunken)",
          elevated: "var(--surface-elevated)",
          canvas: "var(--surface-canvas)"
        },
        // F039 调和状态/身份色（见文件头注释；alias 家族指向同一对象，渲染完全一致）
        red,
        rose: red,
        amber,
        orange: amber,
        yellow: amber,
        green,
        emerald: green,
        lime: green,
        teal,
        cyan: teal,
        blue,
        sky: blue,
        violet,
        indigo: violet,
        purple: violet,
        fuchsia: violet,
        // 暖金 accent（≈Claude clay）——给 text-accent / bg-accent-50 等
        accent: {
          50: "var(--accent-50)",
          100: "var(--accent-100)",
          200: "var(--accent-200)",
          300: "var(--accent-300)",
          400: "var(--accent-400)",
          500: "var(--accent-500)",
          600: "var(--accent-600)",
          700: "var(--accent-700)",
          900: "var(--accent-900)",
          DEFAULT: "var(--accent-500)"
        }
      },
      boxShadow: {
        // 全站 shadow-{sm/md/lg/xl} 自动吃 clowder elevation token（柔、单层）
        sm: "var(--shadow-elevation-1)",
        DEFAULT: "var(--shadow-elevation-1)",
        md: "var(--shadow-elevation-2)",
        lg: "var(--shadow-elevation-3)",
        xl: "var(--shadow-elevation-3)",
        soft: "var(--shadow-elevation-1)",
        // F039: 主 CTA 暖金光晕（accent-500 同源 oklch + alpha；替换散落的 shadow-amber-500/20 任意值）
        glow: "0 6px 16px oklch(0.55 0.14 50 / 0.22)"
      },
      borderRadius: {
        // F036 #4 圆角统一：4 档语义半径，全站消灭散落的 rounded-[Npx] 任意值。
        // ⚠️ 刻意不叫 `xl`——会撞 Tailwind 内置 rounded-xl(12px)，override 会静默改写
        // 全站 rounded-xl（含 provider-avatar 头像 squircle）。顶层用 `floating`。
        // 例外：provider-avatar 的 rounded-[10/22/32px] 是随尺寸渐变的头像 squircle 阶梯
        // （另一套视觉语言），不纳入本刻度。
        field: "12px", // 输入框 / 按钮 / select / 小 chip
        card: "16px", // 卡片 / 列表项 / 观测条
        panel: "20px", // 抽屉 / 面板 / composer 外壳
        floating: "24px" // 最外层浮层：连接气泡 / timeline 滚动容器
      }
    }
  },
  plugins: []
};

export default config;
