import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminateEngine } from '../../electron/engine-shutdown'

class FakeChild extends EventEmitter {
  pid = 999_999
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  kill = vi.fn((_signal?: NodeJS.Signals) => {
    this.killed = true
    return true
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('engine shutdown coordination', () => {
  it('waits for the actual exit and cancels the force timer', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
    const forced = vi.fn()
    let done = false
    const pending = terminateEngine(child as unknown as ChildProcess, forced, 1_000).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(done).toBe(false)
    child.exitCode = 0
    child.emit('exit', 0, null)
    await pending
    await vi.advanceTimersByTimeAsync(2_000)
    expect(forced).not.toHaveBeenCalled()
    expect(signal).toHaveBeenCalledExactlyOnceWith(-child.pid, 'SIGTERM')
  })

  it('forces an unreaped child even when killed only means SIGTERM was sent', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    child.killed = true
    const signal = vi.spyOn(process, 'kill').mockImplementation((_pid, value) => {
      if (value === 'SIGKILL') {
        child.signalCode = 'SIGKILL'
        child.emit('exit', null, 'SIGKILL')
      }
      return true
    })
    const forced = vi.fn()
    const pending = terminateEngine(child as unknown as ChildProcess, forced, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await pending
    expect(forced).toHaveBeenCalledOnce()
    expect(signal).toHaveBeenCalledWith(-child.pid, 'SIGKILL')
  })

  it('bounds an unresponsive OS path while falling back to direct child signals', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('no group')
    })
    const pending = terminateEngine(child as unknown as ChildProcess, vi.fn(), 1_000)
    await vi.advanceTimersByTimeAsync(3_000)
    await pending
    expect(child.kill.mock.calls.map((args) => args[0])).toEqual(['SIGTERM', 'SIGKILL'])
  })
})
