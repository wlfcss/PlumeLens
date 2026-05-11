import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export function IconButton({
  active,
  ariaKeyShortcuts,
  children,
  className,
  disabled,
  label,
  onClick,
  title,
}: {
  active?: boolean
  ariaKeyShortcuts?: string
  children: ReactNode
  className?: string
  disabled?: boolean
  label: string
  onClick?: () => void
  title?: string
}) {
  return (
    <button
      aria-label={label}
      aria-keyshortcuts={ariaKeyShortcuts}
      className={cn('icon-button', active && 'icon-button--active', className)}
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  )
}
