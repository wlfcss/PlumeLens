import type { ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export const ENGINE_SHUTDOWN_GRACE_MS = 15_000

export function forceTerminateEngineTreeSync(pid: number, platform = process.platform): void {
  if (platform === 'win32') {
    execFileSync(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', timeout: 5_000 },
    )
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      process.kill(pid, 'SIGKILL')
    }
  }
}

/** Wait for actual exit, not ChildProcess.killed (which only means a signal was sent). */
export function terminateEngine(
  proc: ChildProcess,
  onForced: () => void,
  graceMs = ENGINE_SHUTDOWN_GRACE_MS,
  platform = process.platform,
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
      if (platform === 'win32') {
        try {
          if (value === 'SIGTERM' && proc.stdin?.writable) {
            proc.stdin.end('PLUMELENS_SHUTDOWN\n')
          } else {
            forceTerminateEngineTreeSync(proc.pid!, platform)
          }
        } catch {
          finish()
        }
        return
      }
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
