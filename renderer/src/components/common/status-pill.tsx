import type { Tone } from '@/lib/photo-helpers'
import { cn } from '@/lib/utils'

export function StatusPill({
  className,
  label,
  tone = 'neutral',
  title,
}: {
  className?: string
  label: string
  tone?: Tone
  title?: string
}) {
  return (
    <span className={cn('status-pill', `status-pill--${tone}`, className)} title={title}>
      {label}
    </span>
  )
}
