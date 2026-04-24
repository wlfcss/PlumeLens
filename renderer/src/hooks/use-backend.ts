import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

export interface BackendHealth {
  status: string
  version: string
  pipeline: {
    ready: boolean
    version: string
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

// Dev/test fallback. 在 Electron 打包环境里这个值会被 preload 覆盖；
// 在 vite dev server（含 Playwright E2E）下作为直连本地后端的默认值。
const FALLBACK_BACKEND_URL = 'http://127.0.0.1:8000'

export function useBackendHealth() {
  const [backendUrl, setBackendUrl] = useState<string | null>(FALLBACK_BACKEND_URL)

  useEffect(() => {
    // In Electron, override with the dynamic port from the preload API
    if (typeof window !== 'undefined' && window.plumelens) {
      window.plumelens.getBackendUrl().then((url) => {
        if (url) setBackendUrl(url)
      })
      window.plumelens.onBackendReady((url) => setBackendUrl(url))
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
