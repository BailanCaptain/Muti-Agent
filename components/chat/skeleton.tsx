"use client"

/**
 * F039 AC5 · 通用加载骨架（pro-max progressive-loading / taste-skill §4.5）。
 * 形状贴列表布局的灰条 + animate-pulse；宽度错落让占位读起来像内容而非条纹墙。
 * 语义：role=status + aria-busy，屏幕阅读器播报"加载中"。
 */
const WIDTHS = ["w-[92%]", "w-[78%]", "w-[85%]", "w-[64%]", "w-[88%]", "w-[71%]"]

export function SkeletonLines({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="加载中"
      className={`flex animate-pulse flex-col gap-2 py-1 ${className}`}
    >
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          data-skeleton-line
          className={`h-3 rounded-full bg-slate-200/80 ${WIDTHS[i % WIDTHS.length]}`}
        />
      ))}
      <span className="sr-only">加载中</span>
    </div>
  )
}
