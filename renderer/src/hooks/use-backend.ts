import { useQuery } from '@tanstack/react-query'
import { useState, useEffect } from 'react'

export function useBackendHealth() {
  const [backendUrl, setBackendUrl] = useState<string | null>(null)

  useEffect(() => {
    // In Electron, get URL from preload API
    if (window.plumelens) {
      window.plumelens.getBackendUrl().then(setBackendUrl)
      window.plumelens.onBackendReady((url) => setBackendUrl(url))
    }
  }, [])

  const query = useQuery({
    queryKey: ['backend-health'],
    queryFn: async () => {
      if (!backendUrl) throw new Error('No backend URL')
      const res = await fetch(`${backendUrl}/health`, {
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<{ status: string; version: string }>
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
