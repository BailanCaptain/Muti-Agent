// F040 AC14：PWA 图标绘制（icon.tsx / apple-icon.tsx 共用）。
// 三圆点品字 = 三 agent 同房协作；纯几何零字体依赖（satori 默认仅 Inter latin，文字标会豆腐块）。
// 色 = F036 主题近似 hex：深暖褐底（--accent-900 加深）+ 暖金点（--accent 系）。
export function PwaIconArt({ canvas }: { canvas: number }) {
  const dot = Math.round(canvas * 0.21)
  const gap = Math.round(canvas * 0.07)
  const dotStyle = {
    width: dot,
    height: dot,
    borderRadius: "50%",
    background: "#D9A054",
  }
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap,
        background: "#2E2318",
      }}
    >
      <div style={dotStyle} />
      <div style={{ display: "flex", gap }}>
        <div style={dotStyle} />
        <div style={dotStyle} />
      </div>
    </div>
  )
}
