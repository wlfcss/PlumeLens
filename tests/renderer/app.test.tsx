import React from 'react'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, beforeAll } from 'vitest'
import '@/i18n'
import App from '@/App'

// Mock the Electron preload API
beforeAll(() => {
  window.plumelens = {
    getBackendUrl: async () => null,
    getAppVersion: async () => '0.1.0',
    openFolder: async () => null,
    onBackendReady: () => {},
    onBackendError: () => {},
  }
  // jsdom 不实现 EventSource；useAnalysisProgress 订阅 SSE 时会 ReferenceError
  if (typeof (globalThis as Record<string, unknown>).EventSource === 'undefined') {
    class StubEventSource {
      onmessage: ((ev: MessageEvent) => void) | null = null
      onerror: ((ev: Event) => void) | null = null
      addEventListener(): void {
        // no-op
      }
      close(): void {
        // no-op
      }
    }
    ;(globalThis as Record<string, unknown>).EventSource = StubEventSource
  }
})

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('App', () => {
  it('renders the app title', () => {
    renderWithProviders(<App />)
    expect(screen.getAllByText('鉴翎').length).toBeGreaterThan(0)
  })
})
