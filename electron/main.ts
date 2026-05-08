import { app, BrowserWindow, ipcMain, dialog, net, protocol, session, shell } from 'electron'
import { spawn } from 'child_process'
import { pathToFileURL } from 'url'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { realpath } from 'fs/promises'
import { homedir, platform as osPlatform } from 'os'
import { join, resolve } from 'path'
import { ProcessManager } from './process-manager'
import { mergeUserSettings, readUserSettings, type UserSettings } from './user-settings'

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

const REALPATH_CACHE_TTL_MS = 60_000
const REALPATH_CACHE_MAX = 2048

const realpathCache = new Map<string, { value: string; expiresAt: number }>()

async function cachedRealpath(path: string): Promise<string> {
  const now = Date.now()
  const cached = realpathCache.get(path)
  if (cached && cached.expiresAt > now) {
    // Refresh insertion order so the oldest entry is a true LRU candidate.
    realpathCache.delete(path)
    realpathCache.set(path, cached)
    return cached.value
  }
  if (cached) realpathCache.delete(path)

  const value = await realpath(path)
  realpathCache.set(path, { value, expiresAt: now + REALPATH_CACHE_TTL_MS })
  while (realpathCache.size > REALPATH_CACHE_MAX) {
    const oldest = realpathCache.keys().next()
    if (oldest.done) break
    realpathCache.delete(oldest.value)
  }
  return value
}

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

ipcMain.handle('dialog:select-export-directory', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    buttonLabel: '选择导出位置',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

// 外部编辑器集成 — 信息抽屉 / 复核屏 "用 Topaz/PS 打开"
//
// 探测策略:macOS 应用安装在 /Applications/{Name}.app 或 ~/Applications/{Name}.app。
// 启动期一次性扫描,缓存结果。卸载/安装通常需要重启应用才能感知 — 简单可接受。
//
// 启动方式:Photoshop 走 macOS `open -a`,Topaz Photo 则走 bundle executable。
// Topaz 的外部编辑入口对 `open -a` 的 RAW 路径处理不稳定,会退化成 basename。
type EditorTool = 'topaz' | 'photoshop'

interface EditorEntry {
  /** macOS LaunchServices 识别的应用名(/Applications/{name}.app) */
  appNames: string[]
  /** 探测到的实际应用文件名(用于 open -a 启动);null = 未安装 */
  resolved: string | null
  /** 探测到的 .app 绝对路径;Adobe 系应用常放在 /Applications/AppName/AppName.app */
  appPath: string | null
}

const EDITOR_REGISTRY: Record<EditorTool, EditorEntry> = {
  topaz: {
    // Topaz 2024 年统一改名去掉 "AI" 后缀(Topaz Photo AI → Topaz Photo)。
    // 探测优先新名,fallback 到老名 + 单功能产品(用户可能装多个)。
    appNames: [
      'Topaz Photo', // 现行综合产品(2024+)
      'Topaz Photo AI', // 老综合产品名(2022-2023)
      'Topaz Sharpen AI', // 单功能,锐化
      'Topaz DeNoise AI', // 单功能,降噪
      'Topaz Gigapixel AI', // 单功能,放大
      'Topaz Gigapixel', // 改名后的 Gigapixel
    ],
    resolved: null,
    appPath: null,
  },
  photoshop: {
    // 探测最近几年版本顺序;装多个版本时挑最新
    appNames: [
      'Adobe Photoshop 2026',
      'Adobe Photoshop 2025',
      'Adobe Photoshop 2024',
      'Adobe Photoshop 2023',
      'Adobe Photoshop',
    ],
    resolved: null,
    appPath: null,
  },
}

function findEditorAppPath(root: string, name: string): string | null {
  const candidates = [
    join(root, `${name}.app`),
    // Adobe 系应用通常安装为:
    // /Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app
    join(root, name, `${name}.app`),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function resolveEditors(): void {
  const roots = ['/Applications', join(homedir(), 'Applications')]
  for (const tool of Object.keys(EDITOR_REGISTRY) as EditorTool[]) {
    const entry = EDITOR_REGISTRY[tool]
    for (const name of entry.appNames) {
      const appPath = roots.map((root) => findEditorAppPath(root, name)).find(Boolean) ?? null
      if (appPath) {
        entry.resolved = name
        entry.appPath = appPath
        break
      }
    }
  }
  process.stderr.write(
    `[main] editors detected: ${JSON.stringify(
      Object.fromEntries(
        Object.entries(EDITOR_REGISTRY).map(([k, v]) => [k, v.appPath ?? v.resolved]),
      ),
    )}\n`,
  )
}

function findEditorExecutablePath(entry: EditorEntry): string | null {
  if (!entry.appPath || !entry.resolved) return null
  const executableNames = [entry.resolved]
  try {
    const plist = readFileSync(join(entry.appPath, 'Contents', 'Info.plist'), 'utf-8')
    const match = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)
    if (match?.[1] && !executableNames.includes(match[1])) {
      executableNames.unshift(match[1])
    }
  } catch {
    /* ignore: fallback to resolved app name */
  }
  for (const name of executableNames) {
    const executablePath = join(entry.appPath, 'Contents', 'MacOS', name)
    if (existsSync(executablePath)) return executablePath
  }
  return null
}

function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    })
    let settled = false
    const settle = (callback: () => void): void => {
      if (settled) return
      settled = true
      callback()
    }
    child.once('error', (error) => {
      settle(() => rejectSpawn(error))
    })
    child.once('spawn', () => {
      child.unref()
      settle(() => resolveSpawn())
    })
  })
}

ipcMain.handle('list-editors', () => {
  return {
    topaz: EDITOR_REGISTRY.topaz.resolved,
    photoshop: EDITOR_REGISTRY.photoshop.resolved,
  }
})

ipcMain.handle('open-in-editor', async (_event, args: { tool: EditorTool; path: string }) => {
  const { tool, path: filePath } = args
  const entry = EDITOR_REGISTRY[tool]
  if (!entry || !entry.resolved) {
    return { ok: false, reason: 'not_installed' as const }
  }
  let canonicalPath: string
  try {
    canonicalPath = await realpath(filePath)
  } catch {
    return { ok: false, reason: 'file_missing' as const }
  }
  // detached + unref 让外部编辑器跟主进程脱钩,关闭鉴翎不会拖死编辑器
  try {
    if (tool === 'topaz') {
      const executablePath = findEditorExecutablePath(entry)
      if (executablePath) {
        const topazArgs = entry.resolved.startsWith('Topaz Photo')
          ? ['--editor=PlumeLens', canonicalPath]
          : [canonicalPath]
        await spawnDetached(executablePath, topazArgs)
        return { ok: true, app: entry.resolved }
      }
    }
    const appSpecifier = entry.appPath ?? entry.resolved
    if (!appSpecifier) {
      return { ok: false, reason: 'app_missing' as const }
    }
    await spawnDetached('open', ['-a', appSpecifier, canonicalPath])
    return { ok: true, app: entry.resolved }
  } catch (err) {
    process.stderr.write(`[main] open-in-editor failed: ${(err as Error).message}\n`)
    return { ok: false, reason: 'spawn_failed' as const }
  }
})

ipcMain.handle('open-path-in-finder', async (_event, targetPath: unknown) => {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    return { ok: false, reason: 'invalid_path' as const }
  }

  let canonicalPath: string
  try {
    canonicalPath = await realpath(targetPath)
  } catch {
    return { ok: false, reason: 'path_missing' as const }
  }

  const error = await shell.openPath(canonicalPath)
  if (error) {
    return { ok: false, reason: 'open_failed' as const, message: error }
  }
  return { ok: true as const }
})

// 用户设置(reverse geocoding API keys 等)— 持久化到 userData/settings.json,
// 落盘前每个 key 都过 Electron safeStorage 加密(macOS Keychain / Win DPAPI /
// Linux libsecret),详见 ./user-settings.ts。process-manager 启动 engine 时
// 读这个文件解密后注入 env var,保存后须 restart-engine 才生效。

ipcMain.handle('get-user-settings', () => readUserSettings())

ipcMain.handle('save-user-settings', (_event, partial: UserSettings) => mergeUserSettings(partial))

// 重启 engine — settings 修改后调,让新 key 生效
ipcMain.handle('restart-engine', async () => {
  if (processManager) {
    await processManager.restart()
  }
  return true
})

// 让用户在 fatal 状态点 banner 直接打开 logs 目录(crash 自查 / 上报)
ipcMain.handle('open-logs-dir', async () => {
  const logsDir = join(app.getPath('userData'), 'logs')
  // 兜底:用户可能清过 ~/Library/Application Support/plumelens 目录,这里建空 dir
  // 避免 shell.openPath 返回错误字符串而 banner 看上去"按了无反应"。
  try {
    mkdirSync(logsDir, { recursive: true })
  } catch {
    /* ignore — openPath 也会报错给 caller */
  }
  await shell.openPath(logsDir)
  return logsDir
})

/**
 * userData 目录访问权限收紧到 owner-only (POSIX 0o700)。
 *
 * userData 包含: 鸟摄数据库 (plumelens.db, photos / decisions / archive),
 * 缩略图 (derived/thumbnails),engine 日志 (logs/engine.jsonl 含路径 / EXIF /
 * GPS),用户 settings (amapKey/baiduAk/tencentKey 短期还在 plain text JSON 中)。
 * 默认 macOS userData (`~/Library/Application Support/plumelens`) 是 0o755 — 同
 * 物理机其他登录账号(共享 Mac 多用户)能读 db 和日志。0o700 让 group/other
 * 都没有 r/x 权限。
 *
 * Windows 没有 POSIX mode,chmod 是 no-op (也不抛),平台统一用同一段代码不分支。
 * Linux 行为同 macOS。每次启动都强制设回(用户手动 chmod 改了我们再纠回来)。
 */
function lockdownUserData(userDataDir: string): void {
  if (osPlatform() === 'win32') return
  try {
    chmodSync(userDataDir, 0o700)
  } catch (err) {
    // 不阻塞启动 — userData 目录可能在 NFS / 外置盘 chmod 不支持的情况下报错。
    // 警告写到 stderr 让用户知道隐私保护没拿满。
    process.stderr.write(`[main] failed to chmod userData to 0o700: ${(err as Error).message}\n`)
  }
}

// Lifecycle
app.whenReady().then(async () => {
  // 在写任何文件之前先确保 userData 存在 + 锁权限,避免 settings.json / logs 等
  // 后续步骤把数据落到默认 0o755 目录上(权限收紧只对未来写入有意义,旧文件
  // 已经落盘的话需要手动 chmod 一次)。
  const userDataDir = app.getPath('userData')
  try {
    mkdirSync(userDataDir, { recursive: true })
  } catch {
    /* parent missing 等极端情况 — 后续具体步骤还会再 mkdir */
  }
  lockdownUserData(userDataDir)

  const thumbnailsRoot = join(userDataDir, 'derived', 'thumbnails')
  const rootResolved = resolve(thumbnailsRoot)
  // 启动期一次性算 realpath(thumbnailsRoot) — userData 目录在应用运行期间不会变,
  // 之前每个 plumelens:// 请求都重新 realpath 这个根,大量并发缩略图加载时会让
  // main process 的 fs worker 排队。先尝试 realpath,thumbnailsRoot 不存在时
  // (首次启动 / 数据被清)用 rootResolved 兜底,等首次 ensure_dir 后下次启动再算对。
  let realRootCache: string = rootResolved
  try {
    realRootCache = await realpath(thumbnailsRoot)
  } catch {
    /* dir 不存在,后续按需 realpath 单文件时会触发创建 */
  }
  process.stderr.write(`[main] userData=${app.getPath('userData')}\n`)
  process.stderr.write(`[main] thumbnailsRoot=${thumbnailsRoot}\n`)
  resolveEditors()
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
    if (!resolved.startsWith(rootResolved + '/') && resolved !== rootResolved) {
      return new Response('Forbidden (escape)', { status: 403 })
    }
    try {
      // realpath 单文件确认真实落点(防 thumbnailsRoot 内 symlink 逃逸);
      // root 用启动期缓存的 realRootCache,无需每次重算。
      const realFile = await cachedRealpath(resolved)
      if (!realFile.startsWith(realRootCache + '/') && realFile !== realRootCache) {
        return new Response('Forbidden (symlink escape)', { status: 403 })
      }
      return await net.fetch(pathToFileURL(realFile).toString())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[thumb] failed rel=${rel} resolved=${resolved} error=${message}\n`)
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
    | {
        kind: 'crashed'
        code: number | null
        signal: string | null
        restartCount: number
        maxRestarts: number
      }
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

  processManager.on(
    'crashed',
    (info: {
      code: number | null
      signal: string | null
      restartCount: number
      maxRestarts: number
    }) => {
      sendStatus({ kind: 'crashed', ...info })
    },
  )

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

// 兜底:Node 进程意外退出(崩溃 / 被 kill)时杀 engine。
// detached: true 的子进程不会随 Electron 死,必须显式 cleanup。
//
// process.on('exit') 触发时事件循环已停 — stop() 内部的 setTimeout 不会 fire,
// 异步 SIGTERM→SIGKILL 兜底链全部失效。这里走同步 process.kill(-pid, 'SIGKILL')
// 直接杀进程组(spawn 时 detached:true,pgid == pid)。
process.on('exit', () => {
  const pid = processManager?.getEnginePid()
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* ignore — proc already dead */
      }
    }
  }
})

// uncaughtException / unhandledRejection 兜底 — 没这两个 handler 时崩溃路径
// 不触发 before-quit / SIGTERM,stop() 永不调用,Python engine 残留。
process.on('uncaughtException', (err) => {
  process.stderr.write(`[main] uncaughtException: ${err.message}\n${err.stack ?? ''}\n`)
  try {
    processManager?.stop()
  } catch {
    /* ignore — best effort */
  }
  app.quit()
})
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[main] unhandledRejection: ${String(reason)}\n`)
})

process.on('SIGTERM', () => {
  processManager?.stop()
  app.quit()
})
process.on('SIGINT', () => {
  processManager?.stop()
  app.quit()
})
