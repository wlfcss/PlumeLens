import { app, BrowserWindow, ipcMain, dialog, session } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { ProcessManager } from './process-manager'

let mainWindow: BrowserWindow | null = null
let processManager: ProcessManager | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // CSP
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:*; img-src 'self' data: blob:",
        ],
      },
    })
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// IPC handlers
ipcMain.handle('get-backend-url', () => {
  return processManager?.getUrl() ?? null
})

ipcMain.handle('get-app-version', () => {
  return app.getVersion()
})

ipcMain.handle('dialog:open-folder', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

// Lifecycle
app.whenReady().then(async () => {
  processManager = new ProcessManager()

  processManager.on('ready', (url: string) => {
    mainWindow?.webContents.send('backend-ready', url)
  })

  processManager.on('error', (msg: string) => {
    mainWindow?.webContents.send('backend-error', msg)
  })

  createWindow()
  await processManager.start()
})

app.on('window-all-closed', () => {
  processManager?.stop()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  processManager?.stop()
})
