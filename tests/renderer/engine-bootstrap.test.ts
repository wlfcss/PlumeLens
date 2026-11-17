import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeEngineStatus, useEngineStore } from '../../renderer/src/stores/engine-store'

const originalBridge = window.plumelens
afterEach(() => {
  window.plumelens = originalBridge
  useEngineStore.getState().reset()
})

describe('engine subscription bootstrap', () => {
  it('restores readiness when the renderer reloads after the ready event', async () => {
    window.plumelens = {
      getBackendUrl: vi.fn().mockResolvedValue('http://127.0.0.1:1234'),
      onEngineStatus: vi.fn().mockReturnValue(vi.fn()),
    } as unknown as NonNullable<Window['plumelens']>
    useEngineStore.setState({ state: 'reconnecting' })
    const dispose = subscribeEngineStatus()
    await Promise.resolve()
    expect(useEngineStore.getState()).toMatchObject({
      state: 'ready',
      backendUrl: 'http://127.0.0.1:1234',
    })
    dispose()
  })

  it('does not overwrite a new crash event with a stale URL response', async () => {
    let resolveUrl!: (url: string) => void
    let receive!: Parameters<NonNullable<Window['plumelens']>['onEngineStatus']>[0]
    window.plumelens = {
      getBackendUrl: () =>
        new Promise<string>((resolve) => {
          resolveUrl = resolve
        }),
      onEngineStatus: (callback: typeof receive) => {
        receive = callback
        return vi.fn()
      },
    } as unknown as NonNullable<Window['plumelens']>
    const dispose = subscribeEngineStatus()
    receive({ kind: 'crashed', code: null, signal: 'SIGKILL', restartCount: 1, maxRestarts: 3 })
    resolveUrl('http://127.0.0.1:1234')
    await Promise.resolve()
    expect(useEngineStore.getState().state).toBe('reconnecting')
    expect(useEngineStore.getState().backendUrl).toBeNull()
    dispose()
  })

  it('ignores a bootstrap result after unsubscription', async () => {
    let resolveUrl!: (url: string) => void
    const unsubscribe = vi.fn()
    window.plumelens = {
      getBackendUrl: () =>
        new Promise<string>((resolve) => {
          resolveUrl = resolve
        }),
      onEngineStatus: () => unsubscribe,
    } as unknown as NonNullable<Window['plumelens']>
    useEngineStore.setState({ state: 'reconnecting' })
    const dispose = subscribeEngineStatus()
    dispose()
    resolveUrl('http://127.0.0.1:1234')
    await Promise.resolve()
    expect(useEngineStore.getState().state).toBe('reconnecting')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
