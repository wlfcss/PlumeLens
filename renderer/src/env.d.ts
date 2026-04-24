/// <reference types="vite/client" />

interface PlumeLensAPI {
  getBackendUrl(): Promise<string | null>
  getAppVersion(): Promise<string>
  openFolder(): Promise<string | null>
  onBackendReady(cb: (url: string) => void): void
  onBackendError(cb: (msg: string) => void): void
}

declare global {
  interface Window {
    plumelens?: PlumeLensAPI
  }
}

export {}
