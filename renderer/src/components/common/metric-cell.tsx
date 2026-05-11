import { cn } from '@/lib/utils'
import type { Tone } from '@/lib/photo-helpers'

export function MetricCell({
  label,
  tone = 'neutral',
  value,
}: {
  label: string
  tone?: Tone
  value: number | string
}) {
  return (
    <div className="metric-cell">
      <span>{label}</span>
      <strong>{value}</strong>
      <StatusDot tone={tone} />
    </div>
  )
}

export function StatusDot({ tone = 'neutral' }: { tone?: Tone }) {
  return <span className={cn('status-dot', `status-dot--${tone}`)} />
}
