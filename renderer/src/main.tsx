import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './i18n'
import './app.css'
import App from './App'
import { ApiError } from '@/lib/api-client'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // retry 必须扛过 engine cold start ~5s(PyInstaller 自解压 + 5 个模型加载)。
      // 旧 retry=1 在 1s 内两次失败就放弃 → useLibraries 等永久卡 error,装新 dmg
      // 后历史不显示。改成 3 次 + 指数 backoff(1s/2s/4s ≈ 7s 总窗口)能覆盖冷启。
      // 4xx 业务错(401/403/404)不重试,避免无意义 hammer 后端 + 让 UI 立即报错。
      // 网络层错(status=0)和 5xx 才重试。
      retry: (failureCount, err) => {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false
        return failureCount < 3
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
