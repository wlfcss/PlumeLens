import type { Tone } from '@/lib/photo-helpers'
import { cn } from '@/lib/utils'

// 12 格小方阵 — 用作进度/百分比的离散可视化(folder 分析进度 / collection 点亮率)。
export function GlyphMatrix({
  indeterminate = false,
  tone,
  value,
}: {
  indeterminate?: boolean
  tone: Tone
  value: number
}) {
  return (
    <span
      className={cn('glyph-matrix', indeterminate && 'glyph-matrix--indeterminate')}
      aria-hidden="true"
    >
      {Array.from({ length: 12 }, (_item, index) => (
        <i
          className={cn((indeterminate || index < value) && `tone-${tone}`)}
          key={`glyph-${index + 1}`}
          style={indeterminate ? { animationDelay: `${(index % 4) * 140}ms` } : undefined}
        />
      ))}
    </span>
  )
}
