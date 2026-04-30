import { create } from 'zustand'

// 与 electron/preload.ts 的 EngineStatusPayload 保持一致 — 改动需同步。
// 避免从 env.d.ts import(声明文件作 module 在某些 tsconfig 配置下不稳定),
// 这里就近重声明,有差异 typecheck 会爆。
type EngineStatusPayload =
  | { kind: 'ready'; url: string }
  | { kind: 'unhealthy'; consecutiveFailures: number; threshold: number }
  | {
      kind: 'crashed'
      code: number | null
      signal: string | null
      restartCount: number
      maxRestarts: number
    }
  | { kind: 'fatal'; message: string }
  | { kind: 'cpu-fallback' }

/** 引擎运行状态(产品语义,非技术分类):
 * - ready    正常分析中 / idle
 * - degraded 已降级到 CPU 模式后稳定运行(species 走 CPU,慢但不崩)
 * - reconnecting 后端不健康或重启中,UI 应停止接受用户操作 + 显示重连进度
 * - fatal    重启上限达到,UI 显示错误页 + "重启应用" CTA
 */
export type EngineState = 'ready' | 'degraded' | 'reconnecting' | 'fatal'

interface CrashRecord {
  /** ISO timestamp */
  at: string
  /** SIGABRT / SIGSEGV / HEALTH_FAILURE 等 */
  signal: string | null
  code: number | null
}

interface EngineStore {
  state: EngineState
  /** 最近一次崩溃信息(用于 toast 展示) */
  lastCrash: CrashRecord | null
  /** 重启进度,UI 显示 (n/maxRestarts) */
  restartCount: number
  maxRestarts: number
  /** 累积崩溃次数 — 诊断展示 */
  totalCrashes: number
  /** SSE 重建触发器 — engine ready 后 +1,所有用 useAnalysisProgress 的 hook 重订阅 */
  sseRestartKey: number
  /** 当前后端 URL — 'ready' 才有,其他状态为 null */
  backendUrl: string | null
  /** 是否已切到 CPU 降级模式(graceful degrade) */
  cpuFallback: boolean

  // ---- actions ----
  applyStatus: (payload: EngineStatusPayload) => void
  /** 后端通过 health 端点上报已切到 CPU 时调用 */
  markCpuFallback: () => void
  reset: () => void
}

const INITIAL_STATE = {
  state: 'reconnecting' as EngineState,
  lastCrash: null,
  restartCount: 0,
  maxRestarts: 3,
  totalCrashes: 0,
  sseRestartKey: 0,
  backendUrl: null,
  cpuFallback: false,
} as const

export const useEngineStore = create<EngineStore>()((set, get) => ({
  ...INITIAL_STATE,

  applyStatus: (payload) => {
    switch (payload.kind) {
      case 'ready': {
        const wasUnhealthy = get().state !== 'ready' && get().state !== 'degraded'
        set((s) => ({
          state: s.cpuFallback ? 'degraded' : 'ready',
          backendUrl: payload.url,
          // 从 reconnecting/fatal 恢复 → bump key 让 SSE 重建(端口可能变了)
          sseRestartKey: wasUnhealthy ? s.sseRestartKey + 1 : s.sseRestartKey,
          // restart 流程结束,reset 计数(但保留 totalCrashes 累计)
          restartCount: 0,
        }))
        break
      }
      case 'unhealthy': {
        // 累积失败但还没到重启 — 仅在已经 reconnecting 时不重复刷,避免抖动
        if (get().state !== 'reconnecting') {
          set({ state: 'reconnecting' })
        }
        break
      }
      case 'crashed': {
        set((s) => ({
          state: 'reconnecting',
          backendUrl: null,
          restartCount: payload.restartCount,
          maxRestarts: payload.maxRestarts,
          totalCrashes: s.totalCrashes + 1,
          lastCrash: {
            at: new Date().toISOString(),
            signal: payload.signal,
            code: payload.code,
          },
        }))
        break
      }
      case 'fatal': {
        set({
          state: 'fatal',
          backendUrl: null,
        })
        break
      }
      case 'cpu-fallback': {
        // process-manager 决定切 CPU 后通知 — 持久标志,即使后续恢复 ready
        // 也保持 degraded 显示(避免用户误以为 GPU 恢复)。
        set((s) => ({
          cpuFallback: true,
          state: s.state === 'ready' ? 'degraded' : s.state,
        }))
        break
      }
    }
  },

  markCpuFallback: () => {
    set((s) => ({
      cpuFallback: true,
      // 如果当前 ready,降级标签即时切到 degraded
      state: s.state === 'ready' ? 'degraded' : s.state,
    }))
  },

  reset: () => set({ ...INITIAL_STATE }),
}))

/** 一次性 wire 到 window.plumelens.onEngineStatus,在 App 顶层调一次。 */
export function subscribeEngineStatus(): () => void {
  if (typeof window === 'undefined' || !window.plumelens?.onEngineStatus) {
    // dev shell / 测试环境无 IPC — 直接当作 ready
    useEngineStore.setState({ state: 'ready', backendUrl: null })
    return () => {}
  }
  return window.plumelens.onEngineStatus((payload) => {
    useEngineStore.getState().applyStatus(payload)
  })
}
