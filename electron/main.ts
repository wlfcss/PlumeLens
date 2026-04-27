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
    const url = new URL(request.url)
    if (url.host !== 'thumb') {
      return new Response('Bad host', { status: 400 })
    }
    // 双重解码后再检查（防 URL 双层编码绕过：%252e%252e → %2e%2e → ..）
    let rel: string
    try {
      rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      // 二次解码并验证不含上溯字符
      const reDecoded = decodeURIComponent(rel)
      if (reDecoded !== rel || reDecoded.includes('..')) {
        return new Response('Forbidden (path traversal)', { status: 403 })
      }
    } catch {
      return new Response('Bad URL', { status: 400 })
    }
    if (!rel.startsWith('grid/') && !rel.startsWith('preview/')) {
      return new Response('Forbidden (bad prefix)', { status: 403 })
    }
    const filePath = join(thumbnailsRoot, rel)
    // path.resolve 后必须仍在 thumbnailsRoot 之内（防 symlink 跳出）
    const { resolve, normalize } = await import('path')
    const resolved = resolve(filePath)
    const rootResolved = resolve(thumbnailsRoot)
    if (!resolved.startsWith(rootResolved + '/') && resolved !== rootResolved) {
      return new Response('Forbidden (escape)', { status: 403 })
    }
    void normalize  // unused
    const fileUrl = pathToFileURL(resolved).toString()
    try {
      return await net.fetch(fileUrl)
    } catch {
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
  // macOS：关闭窗口 != 退出应用（用户预期 dock 还在）。**不要** stop engine，
  // 否则用户从 dock 重开窗口会拿到死后端。
  // 非 macOS：关窗即退出应用，stop 由 before-quit 兜底。
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // 真正退出（cmd-Q / 关闭整个应用）才杀 engine。
  processManager?.stop()
})

// 兜底：Node 进程意外退出（崩溃 / 被 kill）时也尝试杀 engine。
// detached: true 的子进程不会随 Electron 死，必须显式 cleanup。
process.on('exit', () => {
  processManager?.stop()
})
process.on('SIGTERM', () => {
  processManager?.stop()
  app.quit()
})
process.on('SIGINT', () => {
  processManager?.stop()
  app.quit()
})
