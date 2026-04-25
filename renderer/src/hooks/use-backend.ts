import { useQuery } from '@tanstack/react-query'
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
        plumelens.getBackendUrl().then((url) => {
          if (cancelled) return
          if (url) {
            setBackendUrl(url)
          } else {
            setTimeout(poll, 500)
          }
        })
      }
      poll()
      plumelens.onBackendReady((url) => {
        cancelled = true
        setBackendUrl(url)
      })
      return () => {
        cancelled = true
      }
    }
  }, [])

  const query = useQuery({
    queryKey: ['backend-health', backendUrl],
    queryFn: async () => {
      if (!backendUrl) throw new Error('No backend URL')
      const res = await fetch(`${backendUrl}/health`, {
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<BackendHealth>
    },
    enabled: !!backendUrl,
    refetchInterval: 10000,
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
