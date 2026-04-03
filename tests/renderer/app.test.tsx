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
    expect(screen.getByText('鉴翎')).toBeInTheDocument()
  })
})
