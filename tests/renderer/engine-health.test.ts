import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/private/tmp/plumelens-health-test' },
  safeStorage: {},
}))
import { ProcessManager } from '../../electron/process-manager'

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function healthManager() {
  const manager = new ProcessManager()
  const control = manager as unknown as {
    url: string
    startHealthCheck(): void
    stopHealthCheck(): void
  }
  control.url = 'http://127.0.0.1:12345'
  cleanup = () => control.stopHealthCheck()
  return { manager, control }
}

describe('engine health lifecycle', () => {
  it('restores the ready event after a transient failure without restarting the engine', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary disconnect'))
        .mockResolvedValue({ ok: true }),
    )
    const { manager, control } = healthManager()
    const ready = vi.fn(),
      unhealthy = vi.fn()
    manager.on('ready', ready)
    manager.on('unhealthy', unhealthy)
    control.startHealthCheck()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(unhealthy).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ready).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:12345')
  })

  it('ignores an old in-flight health response after changing engine URL', async () => {
    vi.useFakeTimers()
    let resolve!: (response: { ok: boolean; status: number }) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done
          }),
      ),
    )
    const { manager, control } = healthManager()
    const unhealthy = vi.fn(),
      ready = vi.fn()
    manager.on('unhealthy', unhealthy)
    manager.on('ready', ready)
    control.startHealthCheck()
    await vi.advanceTimersByTimeAsync(10_000)
    control.url = 'http://127.0.0.1:23456'
    resolve({ ok: false, status: 500 })
    await vi.advanceTimersByTimeAsync(0)
    expect(unhealthy).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
  })
})
