import { app, BrowserWindow, ipcMain, dialog, net, protocol, session, shell } from 'electron'
import { pathToFileURL } from 'url'
import { mkdirSync } from 'fs'
import { realpath } from 'fs/promises'
import { join, resolve } from 'path'
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
  const isDev = !app.isPackaged
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
    const contentSecurityPolicy = isDev
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

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
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

ipcMain.handle('get-backend-auth-token', () => {
  return processManager?.getAuthToken() ?? null
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

// 让用户在 fatal 状态点 banner 直接打开 logs 目录(crash 自查 / 上报)
ipcMain.handle('open-logs-dir', async () => {
  const logsDir = join(app.getPath('userData'), 'logs')
  // 兜底:用户可能清过 ~/Library/Application Support/plumelens 目录,这里建空 dir
  // 避免 shell.openPath 返回错误字符串而 banner 看上去"按了无反应"。
  try {
    mkdirSync(logsDir, { recursive: true })
  } catch { /* ignore — openPath 也会报错给 caller */ }
  await shell.openPath(logsDir)
  return logsDir
})

// Lifecycle
app.whenReady().then(async () => {
  const thumbnailsRoot = join(app.getPath('userData'), 'derived', 'thumbnails')
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
    // path.resolve 后必须仍在 thumbnailsRoot 之内（防普通 path traversal）
    const resolved = resolve(filePath)
    const rootResolved = resolve(thumbnailsRoot)
    if (!resolved.startsWith(rootResolved + '/') && resolved !== rootResolved) {
      return new Response('Forbidden (escape)', { status: 403 })
    }
    try {
      // realpath 再确认真实落点，防止 thumbnailsRoot 内的 symlink 指向外部文件。
      const realRoot = await realpath(thumbnailsRoot)
      const realFile = await realpath(resolved)
      if (!realFile.startsWith(realRoot + '/') && realFile !== realRoot) {
        return new Response('Forbidden (symlink escape)', { status: 403 })
      }
      return await net.fetch(pathToFileURL(realFile).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  processManager = new ProcessManager()

  // Engine 状态机 IPC：把 process-manager 的内部事件统一翻译成 'engine-status'
  // payload,renderer 一个订阅就拿到所有事件,不用维护多个 channel。
  // 状态:
  //  - ready          已就绪(冷启或重启成功)
  //  - unhealthy      health check 累积失败,准备重启
  //  - crashed        子进程 abort/exit,即将重启 (含尝试次数)
  //  - fatal          重启上限达到 / 启动期失败,需用户介入
  type EngineStatusPayload =
    | { kind: 'ready'; url: string }
    | { kind: 'unhealthy'; consecutiveFailures: number; threshold: number }
    | { kind: 'crashed'; code: number | null; signal: string | null; restartCount: number; maxRestarts: number }
    | { kind: 'fatal'; message: string }
    | { kind: 'cpu-fallback' }

  const sendStatus = (payload: EngineStatusPayload): void => {
    mainWindow?.webContents.send('engine-status', payload)
  }

  processManager.on('ready', (url: string) => {
    sendStatus({ kind: 'ready', url })
    // 兼容老 channel(早期 renderer 还在用)
    mainWindow?.webContents.send('backend-ready', url)
  })

  processManager.on('unhealthy', (info: { consecutiveFailures: number; threshold: number }) => {
    sendStatus({ kind: 'unhealthy', ...info })
  })

  processManager.on('crashed', (info: { code: number | null; signal: string | null; restartCount: number; maxRestarts: number }) => {
    sendStatus({ kind: 'crashed', ...info })
  })

  // graceful degrade 触发后 emit 一次,UI 持续显示 CPU 降级横幅
  processManager.on('cpu-fallback', () => {
    sendStatus({ kind: 'cpu-fallback' })
  })

  processManager.on('error', (msg: string) => {
    sendStatus({ kind: 'fatal', message: msg })
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

app.on('activate', () => {
  // macOS Dock 激活时重建窗口；engine 进程保持原样，preload 会继续取现有 URL。
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
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
