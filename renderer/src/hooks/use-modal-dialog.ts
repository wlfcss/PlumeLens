import { useLayoutEffect, useRef } from 'react'

/** Electron's native modal provides inert background, Tab containment and focus return. */
export function useModalDialog(open = true) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    if (!dialog.open) dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [open])
  return ref
}
