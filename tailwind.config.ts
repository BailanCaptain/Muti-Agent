import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Segoe UI", "sans-serif"],
        mono: ["var(--font-mono)", "SFMono-Regular", "Consolas", "monospace"]
      },
      colors: {
        // F036 restyle（移植 clowder neutral）：slate 全站重映射成"几乎不带色的暖灰"
        // （OKLCH hue 30 / chroma 0.005 → hex），一处生效全站去"股票 Tailwind 冷蓝脸"。
        // 用 hex 而非 var() 是为了保留 `slate-200/60` 这类 opacity-modifier。
        slate: {
          50: "#fbfaf9",
          100: "#f4f2f0",
          200: "#e8e5e2",
          300: "#d1cec9",
          400: "#aaa6a1",
          // F036 codex-r1 P2：500 从 #7d7a76(对比 4.27) 微调暗到过 AA 4.5:1
          // （白底实算 ~4.79）——10-12px 次要文本(时间戳/说明)在 elevated/canvas 上可读。
          500: "#75726e",
          600: "#605d59",
          700: "#494744",
          800: "#343230",
          900: "#242220",
          950: "#161513"
        },
        // 4 档表面（吃 globals.css 的 OKLCH token）——给 bg-surface / bg-elevated / bg-canvas / bg-sunken
        surface: {
          DEFAULT: "var(--surface)",
          sunken: "var(--surface-sunken)",
          elevated: "var(--surface-elevated)",
          canvas: "var(--surface-canvas)"
        },
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
        soft: "var(--shadow-elevation-1)"
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
