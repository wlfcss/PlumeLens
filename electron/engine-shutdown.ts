import type { ChildProcess } from 'node:child_process'
import { execFile, execFileSync } from 'node:child_process'
import { join } from 'node:path'

export const ENGINE_SHUTDOWN_GRACE_MS = 15_000

function windowsTaskkillPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
}

export function forceTerminateEngineTreeSync(pid: number, platform = process.platform): void {
  if (platform === 'win32') {
    execFileSync(windowsTaskkillPath(), ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5_000,
    })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      process.kill(pid, 'SIGKILL')
    }
  }
}

function forceTerminateEngineTreeAsync(pid: number, onDone: () => void): void {
  execFile(
    windowsTaskkillPath(),
    ['/PID', String(pid), '/T', '/F'],
    { windowsHide: true, timeout: 5_000 },
    () => onDone(),
  )
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
            if (typeof proc.stdin.on === 'function') {
              proc.stdin.on('error', () => {
                /* ignore EPIPE if child closed stdin while exiting */
              })
            }
            proc.stdin.end('PLUMELENS_SHUTDOWN\n')
          } else {
            forceTerminateEngineTreeAsync(proc.pid!, () => {
              if (proc.exitCode !== null || proc.signalCode !== null) finish()
            })
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
