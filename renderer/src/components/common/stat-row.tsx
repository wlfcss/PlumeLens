import type { Tone } from '@/lib/photo-helpers'
import { cn } from '@/lib/utils'

export function StatRow({
  label,
  onValueClick,
  tone = 'neutral',
  value,
  valueAriaLabel,
}: {
  label: string
  onValueClick?: () => void
  tone?: Tone
  value: number | string
  valueAriaLabel?: string
}) {
  return (
    <div className="stat-row">
      <span>{label}</span>
      {onValueClick ? (
        <button
          aria-label={valueAriaLabel}
          className={cn('stat-row__value-button', `tone-text-${tone}`)}
          onClick={onValueClick}
          type="button"
        >
          {value}
        </button>
      ) : (
        <strong className={`tone-text-${tone}`}>{value}</strong>
      )}
    </div>
  )
}
