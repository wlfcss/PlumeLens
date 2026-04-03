import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('plumelens', {
  getBackendUrl: (): Promise<string | null> => ipcRenderer.invoke('get-backend-url'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-folder'),
  onBackendReady: (cb: (url: string) => void): void => {
    ipcRenderer.on('backend-ready', (_event, url: string) => cb(url))
  },
  onBackendError: (cb: (msg: string) => void): void => {
    ipcRenderer.on('backend-error', (_event, msg: string) => cb(msg))
  },
})
