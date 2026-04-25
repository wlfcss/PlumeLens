import { app, BrowserWindow, ipcMain, dialog, net, protocol, session } from 'electron'
import { pathToFileURL } from 'url'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { ProcessManager } from './process-manager'

// plumelens:// 协议必须在 app ready 之前注册 scheme（标准 + secure），
// 之后在 ready 后通过 protocol.handle 真正接管请求。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'plumelens',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

let mainWindow: BrowserWindow | null = null
let processManager: ProcessManager | null = null

const windowBounds = {
  width: 1680,
  height: 1040,
  minWidth: 1360,
  minHeight: 860,
} as const

function createWindow(): void {
  mainWindow = new BrowserWindow({
    ...windowBounds,
    backgroundColor: '#050505',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // CSP
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const contentSecurityPolicy = is.dev
      ? [
          "default-src 'self' http://localhost:5173 ws://localhost:5173;",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173;",
          "style-src 'self' 'unsafe-inline';",
          "connect-src 'self' http://127.0.0.1:* http://localhost:5173 ws://localhost:5173 plumelens:;",
          "img-src 'self' data: blob: plumelens: https://upload.wikimedia.org;",
          "font-src 'self' data:;",
        ].join(' ')
      : [
          "default-src 'self';",
          "script-src 'self';",
          "style-src 'self' 'unsafe-inline';",
          "connect-src 'self' http://127.0.0.1:* plumelens:;",
          "img-src 'self' data: blob: plumelens: https://upload.wikimedia.org;",
          "font-src 'self' data:;",
        ].join(' ')

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy],
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
  const thumbnailsRoot = join(app.getPath('userData'), 'cache', 'thumbnails')
  process.stderr.write(`[main] userData=${app.getPath('userData')}\n`)
  process.stderr.write(`[main] thumbnailsRoot=${thumbnailsRoot}\n`)
  protocol.handle('plumelens', async (request) => {
    process.stderr.write(`[plumelens] ${request.url}\n`)
    const url = new URL(request.url)
    if (url.host !== 'thumb') {
      process.stderr.write(`[plumelens] bad host: ${url.host}\n`)
      return new Response('Bad host', { status: 400 })
    }
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (rel.includes('..') || (!rel.startsWith('grid/') && !rel.startsWith('preview/'))) {
      process.stderr.write(`[plumelens] forbidden: ${rel}\n`)
      return new Response('Forbidden', { status: 403 })
    }
    const filePath = join(thumbnailsRoot, rel)
    const fileUrl = pathToFileURL(filePath).toString()
    process.stderr.write(`[plumelens] resolved → ${filePath}\n`)
    try {
      const resp = await net.fetch(fileUrl)
      process.stderr.write(`[plumelens] net.fetch status=${resp.status}\n`)
      return resp
    } catch (e) {
      process.stderr.write(`[plumelens] error: ${(e as Error).message}\n`)
      return new Response('Not found', { status: 404 })
    }
  })

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
