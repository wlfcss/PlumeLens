import type { ChildProcess } from 'node:child_process'

export const ENGINE_SHUTDOWN_GRACE_MS = 15_000

/** Wait for actual exit, not ChildProcess.killed (which only means a signal was sent). */
export function terminateEngine(
  proc: ChildProcess,
  onForced: () => void,
  graceMs = ENGINE_SHUTDOWN_GRACE_MS,
): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined)
    return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    let forcedTimer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forcedTimer) clearTimeout(forcedTimer)
      proc.removeListener('exit', finish)
      proc.removeListener('error', finish)
      resolve()
    }
    const signal = (value: NodeJS.Signals) => {
      try {
        process.kill(-proc.pid!, value)
      } catch {
        try {
          proc.kill(value)
        } catch {
          finish()
        }
      }
    }
    const timer = setTimeout(() => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        finish()
        return
      }
      onForced()
      // Keep the application exit path bounded if the OS cannot reap the child.
      forcedTimer = setTimeout(finish, 2_000)
      signal('SIGKILL')
    }, graceMs)
    proc.once('exit', finish)
    proc.once('error', finish)
    signal('SIGTERM')
  })
}
