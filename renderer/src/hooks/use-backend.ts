import { useQuery } from '@tanstack/react-query'
import { logger } from '@/lib/logger'
import { useEffect, useState } from 'react'

export interface BackendHealth {
  status: string
  version: string
  pipeline: {
    ready: boolean
    version: string
    quality_available: boolean
    pose_available: boolean
    species_available: boolean
    models: Record<
      string,
      {
        loaded: boolean
        provider: string | null
      }
    >
  }
}

// Dev/test fallback：vite dev server 直连本地 8000；Electron 打包模式由 preload 提供动态端口
const FALLBACK_BACKEND_URL = 'http://127.0.0.1:8000'

// 启动初值：有 Electron preload 时给 null（等 IPC 提供真端口，避免立刻 fetch 8000 失败），
// 否则用 fallback（vite dev / 单元测试不会无 query）
const initialBackendUrl: string | null =
  typeof window !== 'undefined' && window.plumelens ? null : FALLBACK_BACKEND_URL

export function useBackendHealth() {
  const [backendUrl, setBackendUrl] = useState<string | null>(initialBackendUrl)

  useEffect(() => {
    // In Electron, override with the dynamic port from the preload API
    if (typeof window !== 'undefined' && window.plumelens) {
      // 轮询 IPC：engine 启动初期可能返回 null，每 500ms 拉一次直到拿到 URL
      const plumelens = window.plumelens
      let cancelled = false
      const poll = (): void => {
        if (cancelled) return
        plumelens
          .getBackendUrl()
          .then((url) => {
            if (cancelled) return
            if (url) {
              setBackendUrl(url)
            } else {
              setTimeout(poll, 500)
            }
          })
          .catch((err) => {
            // IPC reject(main 进程 crash / electron HMR 断接)— 不要让链断掉永久
            // 卡 null,继续 backoff 重试。否则 EnginePanel 永远 loading,backendUrl
            // 永远 null,所有走 IPC 的 query 都接不上后端。
            if (cancelled) return
            logger.warn('getBackendUrl IPC failed, retrying:', err)
            setTimeout(poll, 500)
          })
      }
      poll()
      const unsubscribeReady = plumelens.onBackendReady((url) => {
        cancelled = true
        setBackendUrl(url)
      })
      return () => {
        cancelled = true
        if (typeof unsubscribeReady === 'function') unsubscribeReady()
      }
    }
  }, [])

  const query = useQuery({
    queryKey: ['backend-health', backendUrl],
    queryFn: async () => {
      if (!backendUrl) throw new Error('No backend URL')
      // Electron 路径走 preload engineRequest — token 不进 renderer JS(H5)。
      // vite dev / 测试无 preload 时直连 127.0.0.1 fallback,无 token。
      if (typeof window !== 'undefined' && window.plumelens?.engineRequest) {
        const res = await window.plumelens.engineRequest('/health', {
          headers: { 'Content-Type': 'application/json' },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return JSON.parse(res.body) as BackendHealth
      }
      const res = await fetch(`${backendUrl}/health`, {
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<BackendHealth>
    },
    enabled: !!backendUrl,
    // 30s 轮询 /health(只用于读 pipeline ready / 模型加载状态)。
    // 引擎崩溃 / 重启等状态变化由 engineStore 的 SSE 通道实时推送,这里不需要 10s 高
    // 频拉。模型加载完成后 /health 输出基本稳定不变,30s 足够。
    refetchInterval: 30000,
    retry: false,
  })

  return {
    isReady: query.isSuccess,
    isError: query.isError,
    error: query.error,
    data: query.data,
    backendUrl,
  }
}
