import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  net,
  powerMonitor,
  protocol,
  session,
  shell,
} from 'electron'
import { spawn } from 'child_process'
import { pathToFileURL } from 'url'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { readdir, realpath, stat } from 'fs/promises'
import { homedir, platform as osPlatform } from 'os'
import { join, resolve } from 'path'
import { BENCHMARK_TRACE_ARGUMENT } from '../shared/benchmark-trace'
import {
  isValidConfigurableLogLevel,
  LOG_CONSENT_VERSION,
  type ClearLogsResult,
  type ExportDiagnosticsResult,
  type LoggingStatusSnapshot,
  type SystemProfileSnapshot,
} from '../shared/client-log'
import { ProcessManager } from './process-manager'
import { forceTerminateEngineTreeSync } from './engine-shutdown'
import { findWindowsEditor } from './windows-editors'
import { isWithinDirectory, prepareCacheDirectory } from './cache-paths'
import {
  mergeUserSettings,
  readUserSettings,
  SafeStorageUnavailableError,
  type UserSettings,
} from './user-settings'
import {
  readLoggingPreferences,
  readUiPreferences,
  saveLoggingPreferences,
  saveUiPreference,
} from './ui-prefs'
import { readExistingDeviceId, resolveDeviceId, type DeviceIdRecord } from './device-id'
import { getClientLogger, getScopedLogger, initClientLogger } from './logger'
import {
  collectSystemProfile,
  readSystemProfileCache,
  saveSystemProfileCache,
} from './system-profile'
import {
  buildAndWriteDiagnosticsZipAsync,
  clearLogFiles,
  getLogsStorageStats,
} from './log-diagnostics'

// plumelens:// 协议必须在 app ready 之前注册 scheme（标准 + secure），
// 之后在 ready 后通过 protocol.handle 真正接管请求。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'plumelens',
    privileges: {
      standard: true,
      secure: true,
      corsEnabled: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

let mainWindow: BrowserWindow | null = null
let processManager: ProcessManager | null = null
let allowAppQuit = false
let allowWindowClose = false
let closePromptOpen = false
let cachedDeviceRecord: DeviceIdRecord | null = null
let cachedSystemProfile: SystemProfileSnapshot | null = null
let systemProfilePromise: Promise<SystemProfileSnapshot | null> | null = null
const APP_BOOT_STARTED_AT = Date.now()
const SKIP_LOG_CONSENT_PROMPT = process.env['PLUMELENS_E2E_SKIP_LOG_CONSENT'] === '1'
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.exit(0)
app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
})

const windowBounds = {
  width: 1680,
  height: 1040,
  minWidth: 1100,
  minHeight: 700,
} as const

const REALPATH_CACHE_TTL_MS = 60_000
const REALPATH_CACHE_MAX = 2048
const SPECIES_ARTWORK_EXTENSIONS = ['.webp', '.jpg', '.png'] as const
const GITHUB_REPO = 'wlfcss/PlumeLens'
const GITHUB_REPO_PATH = `/${GITHUB_REPO.toLowerCase()}`
const GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
const SKIP_CLOSE_CONFIRM = process.env['PLUMELENS_E2E_DISABLE_CLOSE_CONFIRM'] === '1'

const realpathCache = new Map<string, { value: string; expiresAt: number }>()
const realpathInFlight = new Map<string, Promise<string>>()
let speciesArtworkIndex: Map<string, string> | null = null

function normalizeExternalUrl(target: unknown): string | null {
  if (typeof target !== 'string' || target.trim() === '') return null
  try {
    const url = new URL(target)
    if (url.protocol === 'mailto:') {
      return url.pathname.toLowerCase() === 'wlfcss@gmail.com' ? url.toString() : null
    }
    if (url.protocol === 'maps:') return url.toString()
    if (url.protocol !== 'https:') return null
    const host = url.hostname.toLowerCase()
    const path = url.pathname.toLowerCase()
    const allowed =
      host === 'maps.apple.com' ||
      host === 'wlfcss.com' ||
      host === 'www.wlfcss.com' ||
      (host === 'github.com' &&
        (path === GITHUB_REPO_PATH || path.startsWith(`${GITHUB_REPO_PATH}/`))) ||
      host === 'wikipedia.org' ||
      host.endsWith('.wikipedia.org')
    return allowed ? url.toString() : null
  } catch {
    return null
  }
}

function speciesArtworkKeyFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

function normalizeSpeciesArtworkKey(target: unknown): string | null {
  if (typeof target !== 'string') return null
  const raw = target.trim()
  if (!raw || raw.length > 180) return null
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) return null
  const key = speciesArtworkKeyFromName(raw)
  return key ? key : null
}

function resolveCachedSpeciesArtworkPath(root: string, key: string): string | null {
  if (speciesArtworkIndex !== null) {
    const fileName = speciesArtworkIndex.get(key)
    return fileName ? join(root, fileName) : null
  }
  for (const ext of SPECIES_ARTWORK_EXTENSIONS) {
    const candidate = join(root, `${key}${ext}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function serveLocalCacheFile(
  filePath: string,
  rootResolved: string,
  getRealRoot: () => Promise<string>,
  logPrefix: string,
): Promise<Response> {
  const resolved = resolve(filePath)
  if (!isWithinDirectory(rootResolved, resolved)) {
    return new Response('Forbidden (escape)', { status: 403 })
  }
  try {
    const [realRoot, realFile] = await Promise.all([getRealRoot(), cachedRealpath(resolved)])
    if (!isWithinDirectory(realRoot, realFile)) {
      return new Response('Forbidden (symlink escape)', { status: 403 })
    }
    const fileStat = await stat(realFile)
    if (!fileStat.isFile()) {
      return new Response('Not found', { status: 404 })
    }
    const upstream = await net.fetch(pathToFileURL(realFile).toString())
    const headers = new Headers(upstream.headers)
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    })
  } catch (err) {
    realpathCache.delete(resolved)
    getScopedLogger(logPrefix).warn('serve_local_cache_failed', { logPrefix }, err)
    return new Response('Not found', { status: 404 })
  }
}

function parseVersion(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const parsed = Number.parseInt(part, 10)
      return Number.isFinite(parsed) ? parsed : 0
    })
}

function compareVersions(a: string, b: string): number {
  const av = parseVersion(a)
  const bv = parseVersion(b)
  for (let i = 0; i < Math.max(av.length, bv.length, 3); i += 1) {
    const left = av[i] ?? 0
    const right = bv[i] ?? 0
    if (left > right) return 1
    if (left < right) return -1
  }
  return 0
}

type UpdateCheckResult =
  | {
      ok: true
      currentVersion: string
      latestVersion: string
      hasUpdate: boolean
      releaseUrl: string
      releaseName: string | null
      publishedAt: string | null
    }
  | {
      ok: false
      currentVersion: string
      /** rate_limited 时 message 是配额重置时刻的毫秒时间戳字符串(拿不到则为空串)。 */
      reason: 'network' | 'invalid_response' | 'rate_limited' | 'not_found'
      message: string
    }

async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  try {
    const response = await net.fetch(GITHUB_LATEST_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `PlumeLens/${currentVersion}`,
      },
    })
    if (!response.ok) {
      // GitHub 未认证接口是 60 次/小时/IP,超限返回 403 或 429 并带
      // x-ratelimit-remaining: 0。这跟"网络不通"完全是两回事(等一会儿就好),
      // 直接把 "403" 抛给用户看什么也说明不了。
      const remaining = response.headers.get('x-ratelimit-remaining')
      if ((response.status === 403 || response.status === 429) && remaining === '0') {
        const resetEpoch = Number(response.headers.get('x-ratelimit-reset') ?? '')
        return {
          ok: false,
          currentVersion,
          reason: 'rate_limited',
          message: Number.isFinite(resetEpoch) && resetEpoch > 0 ? String(resetEpoch * 1000) : '',
        }
      }
      if (response.status === 404) {
        return {
          ok: false,
          currentVersion,
          reason: 'not_found',
          message: `${response.status} ${response.statusText}`,
        }
      }
      return {
        ok: false,
        currentVersion,
        reason: 'network',
        message: `${response.status} ${response.statusText}`,
      }
    }
    const payload = (await response.json()) as Record<string, unknown>
    const tagName = payload['tag_name']
    const htmlUrl = payload['html_url']
    if (typeof tagName !== 'string' || typeof htmlUrl !== 'string') {
      return {
        ok: false,
        currentVersion,
        reason: 'invalid_response',
        message: 'GitHub release response missing tag_name/html_url',
      }
    }
    return {
      ok: true,
      currentVersion,
      latestVersion: tagName.replace(/^v/i, ''),
      hasUpdate: compareVersions(tagName, currentVersion) > 0,
      releaseUrl: htmlUrl,
      releaseName: typeof payload['name'] === 'string' ? payload['name'] : null,
      publishedAt: typeof payload['published_at'] === 'string' ? payload['published_at'] : null,
    }
  } catch (err) {
    return {
      ok: false,
      currentVersion,
      reason: 'network',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

const RENDERER_INDEX_URL = pathToFileURL(resolve(__dirname, '../renderer/index.html')).href

function isTrustedAppNavigation(target: string, isDev: boolean): boolean {
  try {
    const url = new URL(target)
    if (url.protocol === 'file:') {
      const normalized = `${url.origin}${url.pathname}`
      const expected = new URL(RENDERER_INDEX_URL)
      return normalized === `${expected.origin}${expected.pathname}`
    }
    if (isDev && process.env['ELECTRON_RENDERER_URL']) {
      const devUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
      return url.origin === devUrl.origin
    }
  } catch {
    return false
  }
  return false
}

function assertTrustedIpcSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): void {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    (event.senderFrame && event.senderFrame !== mainWindow.webContents.mainFrame)
  ) {
    throw new Error('Unauthorized IPC sender')
  }
}

const MACOS_EXECUTABLE_BUNDLE_RE =
  /\.(app|pkg|mpkg|bundle|workflow|action|prefpane|plugin|framework|command)$/i

function getLogsDirPath(): string {
  return join(app.getPath('userData'), 'logs')
}

async function ensureDeviceRecord(persist: boolean): Promise<DeviceIdRecord> {
  if (cachedDeviceRecord && cachedDeviceRecord.source !== 'fallback_random') {
    return cachedDeviceRecord
  }
  const record = await resolveDeviceId(app.getPath('userData'), { persist })
  cachedDeviceRecord = record
  getClientLogger()?.setDeviceId(record.deviceId)
  return record
}

async function ensureSystemProfile(forceRefresh = false): Promise<SystemProfileSnapshot | null> {
  if (!forceRefresh && cachedSystemProfile) return cachedSystemProfile
  if (systemProfilePromise) return systemProfilePromise

  const job = (async (): Promise<SystemProfileSnapshot | null> => {
    try {
      const clientLog = getClientLogger()
      const device = await ensureDeviceRecord(Boolean(clientLog?.isEnabled()))
      const engineRuntime = processManager
        ? await processManager.fetchEngineJson('/health', 2500)
        : null
      const profile = await collectSystemProfile({
        deviceId: device.deviceId,
        deviceIdSource: device.source,
        sessionId: clientLog?.getSessionId() ?? 'unknown',
        appInstallPath: app.getPath('exe'),
        userDataPath: app.getPath('userData'),
        engineRuntime,
      })
      cachedSystemProfile = profile
      if (clientLog?.isEnabled()) {
        saveSystemProfileCache(getLogsDirPath(), profile, device.deviceId)
        clientLog.child('system-profile').info('system_profile_collected', {
          os: `${profile.os.platform} ${profile.os.arch}`,
          cpu: profile.cpu.model,
          logicalCores: profile.cpu.logicalCores,
          totalMemGiB: Math.round((profile.memory.totalBytes / 1024 ** 3) * 10) / 10,
          gpuCount: profile.gpus.length,
          disks: profile.disks.map((d) => ({
            role: d.role,
            fs: d.filesystem,
            media: d.mediaType,
            bus: d.busProtocol,
            freeGiB: d.availableBytes ? Math.round((d.availableBytes / 1024 ** 3) * 10) / 10 : null,
          })),
        })
      }
      return profile
    } catch (err) {
      getScopedLogger('system-profile').warn('system_profile_collect_failed', undefined, err)
      return cachedSystemProfile ?? readSystemProfileCache(getLogsDirPath())
    }
  })()

  systemProfilePromise = job.finally(() => {
    systemProfilePromise = null
  })
  return systemProfilePromise
}

async function refreshEngineRuntimeInProfile(): Promise<void> {
  if (!cachedSystemProfile) {
    await ensureSystemProfile(false)
    return
  }
  const engineRuntime = processManager ? await processManager.fetchEngineJson('/health', 2500) : null
  if (!engineRuntime) return
  cachedSystemProfile = {
    ...cachedSystemProfile,
    engineRuntime,
  }
  const clientLog = getClientLogger()
  if (clientLog?.isEnabled()) {
    saveSystemProfileCache(getLogsDirPath(), cachedSystemProfile, clientLog.getDeviceId())
  }
}

function buildLoggingStatusSnapshot(): LoggingStatusSnapshot {
  const prefs = readLoggingPreferences()
  const clientLog = getClientLogger()
  const logsDir = getLogsDirPath()
  const stats = getLogsStorageStats(logsDir)
  const existingDevice = cachedDeviceRecord ?? readExistingDeviceId(app.getPath('userData'))
  const needsConsentPrompt =
    !SKIP_LOG_CONSENT_PROMPT &&
    (prefs.consent === 'unset' || prefs.consentVersion < LOG_CONSENT_VERSION)

  return {
    consent: prefs.consent,
    consentVersion: prefs.consentVersion,
    enabled: clientLog ? clientLog.isEnabled() : prefs.enabled,
    level: clientLog ? clientLog.getLevel() : prefs.level,
    deviceId: clientLog?.getDeviceId() ?? existingDevice?.deviceId ?? null,
    sessionId: clientLog?.getSessionId() ?? 'unknown',
    logsDir,
    totalBytes: stats.totalBytes,
    fileCount: stats.fileCount,
    crashCount: stats.crashCount,
    needsConsentPrompt,
  }
}

function broadcastLoggingState(): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send('logging-state-changed', buildLoggingStatusSnapshot())
}

function existingDirectoryOrUndefined(dirPath: string | undefined): string | undefined {
  if (!dirPath) return undefined
  try {
    return existsSync(dirPath) ? dirPath : undefined
  } catch {
    return undefined
  }
}

type ClosePromptContent = {
  title: string
  detail: string
  confirmLabel: string
}

const CLOSE_PROMPT_SCHEME = 'plumelens-close-prompt:'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function buildClosePromptHtml(content: ClosePromptContent): string {
  const title = escapeHtml(content.title)
  const detail = escapeHtml(content.detail)
  const confirmLabel = escapeHtml(content.confirmLabel)

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline';"
    />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #050505;
        --panel: #101010;
        --panel-low: #080808;
        --fg: #f4f4f4;
        --muted: #a3a3a3;
        --border: rgba(255, 255, 255, 0.14);
        --border-strong: rgba(255, 255, 255, 0.28);
        --accent: #ff1f2d;
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: transparent;
        color: var(--fg);
        font-family:
          -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC',
          'Hiragino Sans GB', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif;
        text-rendering: optimizeLegibility;
        user-select: none;
        -webkit-font-smoothing: antialiased;
      }

      .overlay {
        display: grid;
        width: 100vw;
        height: 100vh;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(circle at 50% 46%, rgba(255, 255, 255, 0.04), transparent 34%),
          rgba(0, 0, 0, 0.58);
        backdrop-filter: blur(8px);
      }

      .panel {
        width: min(374px, calc(100vw - 48px));
        border: 1px solid var(--border);
        border-radius: 18px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.018)),
          linear-gradient(180deg, var(--panel), var(--panel-low));
        box-shadow:
          0 30px 90px rgba(0, 0, 0, 0.58),
          0 0 0 1px rgba(0, 0, 0, 0.72),
          inset 0 1px 0 rgba(255, 255, 255, 0.055);
        padding: 18px;
      }

      h1 {
        margin: 0;
        color: var(--fg);
        font-size: 17px;
        font-weight: 650;
        letter-spacing: 0;
        line-height: 1.25;
      }

      p {
        margin: 9px 0 0;
        color: var(--muted);
        font-size: 13px;
        font-weight: 450;
        letter-spacing: 0;
        line-height: 1.62;
      }

      .actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 18px;
      }

      .action {
        display: inline-flex;
        height: 36px;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--border);
        border-radius: 9px;
        color: var(--fg);
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0;
        text-decoration: none;
        transition:
          border-color 140ms ease,
          background-color 140ms ease,
          color 140ms ease,
          transform 140ms ease;
      }

      .action:focus-visible {
        outline: 0;
        box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.44);
      }

      .action:hover {
        transform: translateY(-1px);
      }

      .action--primary {
        border-color: rgba(255, 255, 255, 0.82);
        background: #f2f2f2;
        color: var(--bg);
      }

      .action--secondary {
        background: rgba(255, 255, 255, 0.045);
        color: color-mix(in srgb, var(--fg) 86%, transparent);
      }

      .action--secondary:hover {
        border-color: color-mix(in srgb, var(--accent) 44%, var(--border-strong));
        background: color-mix(in srgb, var(--accent) 9%, rgba(255, 255, 255, 0.045));
        color: var(--fg);
      }
    </style>
  </head>
  <body>
    <main class="overlay">
      <section class="panel" role="dialog" aria-modal="true" aria-labelledby="close-title">
        <h1 id="close-title">${title}</h1>
        <p>${detail}</p>
        <div class="actions">
          <a class="action action--primary" href="${CLOSE_PROMPT_SCHEME}//cancel">继续使用</a>
          <a class="action action--secondary" href="${CLOSE_PROMPT_SCHEME}//confirm">${confirmLabel}</a>
        </div>
      </section>
    </main>
  </body>
</html>`
}

async function showClosePromptWindow(
  owner: BrowserWindow,
  content: ClosePromptContent,
): Promise<boolean> {
  if (owner.isDestroyed()) return false
  if (owner.isMinimized()) owner.restore()
  if (!owner.isVisible()) owner.show()

  const bounds = owner.getBounds()
  if (bounds.width < 320 || bounds.height < 200 || bounds.x < -10_000 || bounds.y < -10_000) {
    const result = await dialog.showMessageBox(owner, {
      type: 'question',
      title: content.title,
      message: content.title,
      detail: content.detail,
      buttons: ['继续使用', content.confirmLabel],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    return result.response === 1
  }
  const promptWindow = new BrowserWindow({
    parent: owner,
    modal: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    movable: false,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    backgroundColor: '#00000000',
    hasShadow: false,
    title: content.title,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const promptUrl = `data:text/html;charset=utf-8,${encodeURIComponent(buildClosePromptHtml(content))}`

  return new Promise((resolve) => {
    let settled = false

    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
      if (!promptWindow.isDestroyed()) promptWindow.close()
    }

    promptWindow.webContents.on('will-navigate', (event, target) => {
      if (target.startsWith('data:text/html')) return
      event.preventDefault()
      if (!target.startsWith(CLOSE_PROMPT_SCHEME)) return
      const action = new URL(target).host
      settle(action === 'confirm')
    })
    promptWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        settle(false)
      }
    })
    promptWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    promptWindow.once('closed', () => settle(false))
    promptWindow.once('ready-to-show', () => {
      if (owner.isDestroyed()) {
        settle(false)
        return
      }
      promptWindow.show()
      promptWindow.focus()
    })
    promptWindow.loadURL(promptUrl).catch(() => settle(false))
  })
}

async function requestCloseConfirmation(): Promise<boolean> {
  if (SKIP_CLOSE_CONFIRM) return true
  if (closePromptOpen) return false
  closePromptOpen = true

  const content: ClosePromptContent = {
    title: '确定要退出鉴翎吗？',
    detail: '本地引擎会停止；历史记录和已完成的筛选会保留。',
    confirmLabel: '退出',
  }
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null

  try {
    if (owner) return await showClosePromptWindow(owner, content)
    const result = await dialog.showMessageBox({
      type: 'question',
      title: content.title,
      message: content.title,
      detail: content.detail,
      buttons: ['继续使用', content.confirmLabel],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    return result.response === 1
  } finally {
    closePromptOpen = false
  }
}

function quitWithoutConfirmation(): void {
  allowAppQuit = true
  app.quit()
}

async function openExternalUrl(
  target: unknown,
): Promise<{ ok: true } | { ok: false; reason: 'invalid_url' | 'open_failed'; message?: string }> {
  const url = normalizeExternalUrl(target)
  if (!url) return { ok: false, reason: 'invalid_url' }
  try {
    await shell.openExternal(url)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'open_failed', message }
  }
}

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

  const pending = realpathInFlight.get(path)
  if (pending) return pending

  const job = realpath(path)
    .then((value) => {
      realpathCache.set(path, { value, expiresAt: Date.now() + REALPATH_CACHE_TTL_MS })
      while (realpathCache.size > REALPATH_CACHE_MAX) {
        const oldest = realpathCache.keys().next()
        if (oldest.done) break
        realpathCache.delete(oldest.value)
      }
      return value
    })
    .finally(() => {
      realpathInFlight.delete(path)
    })
  realpathInFlight.set(path, job)
  return job
}

function createWindow(): void {
  const isDev = !app.isPackaged
  mainWindow = new BrowserWindow({
    ...windowBounds,
    backgroundColor: '#050505',
    titleBarStyle:
      process.platform === 'darwin'
        ? 'hiddenInset'
        : process.platform === 'win32'
          ? 'hidden'
          : 'default',
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { color: '#050505', symbolColor: '#e8e8e8', height: 56 } }
      : {}),
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 22 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(process.env['PLUMELENS_BENCHMARK_TRACE'] === '1' && {
        additionalArguments: [BENCHMARK_TRACE_ARGUMENT],
      }),
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedAppNavigation(url, isDev)) return
    event.preventDefault()
    if (normalizeExternalUrl(url)) void openExternalUrl(url)
  })

  // Capture renderer process crashes, hangs, and uncaught third-party console warnings.
  let unresponsiveStartedAt: number | null = null
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const logger = getClientLogger()
    logger?.writeCrashDump(
      'render_process_gone',
      `reason=${details.reason} exitCode=${details.exitCode}`,
      { reason: details.reason, exitCode: details.exitCode },
    )
  })
  mainWindow.webContents.on('unresponsive', () => {
    unresponsiveStartedAt = Date.now()
    getScopedLogger('renderer-watchdog').warn('renderer_unresponsive')
  })
  mainWindow.webContents.on('responsive', () => {
    const durationMs = unresponsiveStartedAt !== null ? Date.now() - unresponsiveStartedAt : null
    unresponsiveStartedAt = null
    getScopedLogger('renderer-watchdog').info('renderer_responsive', {
      ...(durationMs !== null ? { durationMs } : {}),
    })
  })
  mainWindow.webContents.on('console-message', (details) => {
    // Capture only warning (2) / error (3) console messages that did not originate
    // from our own renderer logger facade (which already batches via IPC).
    if (details.level !== 'warning' && details.level !== 'error') return
    if (details.message.startsWith('[pl-log]')) return
    getClientLogger()?.log({
      level: details.level === 'error' ? 'error' : 'warn',
      process: 'renderer',
      scope: 'console',
      category: details.level === 'error' ? 'error' : 'general',
      event: details.message,
      meta: {
        line: details.lineNumber,
        sourceId: details.sourceId ? details.sourceId.split('/').pop() : undefined,
      },
    })
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('close', (event) => {
    if (allowWindowClose || allowAppQuit) return
    event.preventDefault()

    void requestCloseConfirmation().then((confirmed) => {
      if (!confirmed) return
      allowAppQuit = true
      app.quit()
    })
  })

  mainWindow.on('closed', () => {
    allowWindowClose = false
    mainWindow = null
  })
}

// IPC handlers
ipcMain.handle('get-backend-url', (event) => {
  assertTrustedIpcSender(event)
  return processManager?.getUrl() ?? null
})

ipcMain.handle('get-backend-auth-token', (event) => {
  assertTrustedIpcSender(event)
  return processManager?.getAuthToken() ?? null
})

ipcMain.handle('get-app-version', (event) => {
  assertTrustedIpcSender(event)
  return app.getVersion()
})

ipcMain.handle('check-for-updates', (event) => {
  assertTrustedIpcSender(event)
  return checkForUpdates()
})

ipcMain.handle('dialog:open-folder', async (event) => {
  assertTrustedIpcSender(event)
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const prefs = readUiPreferences()
  const defaultPath = existingDirectoryOrUndefined(prefs.lastImportDir)
  const result = await dialog.showOpenDialog(mainWindow, {
    ...(defaultPath ? { defaultPath } : {}),
    properties: ['openDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  saveUiPreference('lastImportDir', result.filePaths[0])
  return result.filePaths[0]
})

ipcMain.handle('dialog:select-export-directory', async (event) => {
  assertTrustedIpcSender(event)
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const prefs = readUiPreferences()
  const defaultPath = existingDirectoryOrUndefined(prefs.lastExportDir)
  const result = await dialog.showOpenDialog(mainWindow, {
    ...(defaultPath ? { defaultPath } : {}),
    buttonLabel: '选择导出位置',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  saveUiPreference('lastExportDir', result.filePaths[0])
  return result.filePaths[0]
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

function isEditorTool(value: unknown): value is EditorTool {
  return value === 'topaz' || value === 'photoshop'
}

function parseOpenInEditorArgs(args: unknown): { tool: EditorTool; filePath: string } | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const maybeArgs = args as { tool?: unknown; path?: unknown }
  if (!isEditorTool(maybeArgs.tool)) return null
  if (typeof maybeArgs.path !== 'string') return null
  const filePath = maybeArgs.path.trim()
  if (!filePath || filePath.includes('\0')) return null
  return { tool: maybeArgs.tool, filePath }
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
  if (process.platform === 'win32') {
    for (const tool of Object.keys(EDITOR_REGISTRY) as EditorTool[]) {
      const entry = EDITOR_REGISTRY[tool]
      entry.appPath = findWindowsEditor(tool)
      entry.resolved = entry.appPath
        ? tool === 'photoshop'
          ? 'Adobe Photoshop'
          : 'Topaz Photo'
        : null
    }
    return
  }
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
  getScopedLogger('main').info('editors_detected', {
    topaz: Boolean(EDITOR_REGISTRY.topaz.resolved),
    photoshop: Boolean(EDITOR_REGISTRY.photoshop.resolved),
  })
}

function findEditorExecutablePath(entry: EditorEntry): string | null {
  if (!entry.appPath || !entry.resolved) return null
  if (process.platform === 'win32') return entry.appPath
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

ipcMain.handle('list-editors', (event) => {
  assertTrustedIpcSender(event)
  return {
    topaz: EDITOR_REGISTRY.topaz.resolved,
    photoshop: EDITOR_REGISTRY.photoshop.resolved,
  }
})

ipcMain.handle('open-in-editor', async (event, args: unknown) => {
  assertTrustedIpcSender(event)
  const parsed = parseOpenInEditorArgs(args)
  if (!parsed) {
    return { ok: false, reason: 'invalid_args' as const }
  }
  const { tool, filePath } = parsed
  const entry = EDITOR_REGISTRY[tool]
  if (!entry || !entry.resolved) {
    return { ok: false, reason: 'not_installed' as const }
  }
  let canonicalPath: string
  try {
    canonicalPath = await realpath(filePath)
    const fileStat = await stat(canonicalPath)
    if (!fileStat.isFile()) {
      return { ok: false, reason: 'file_missing' as const }
    }
  } catch {
    return { ok: false, reason: 'file_missing' as const }
  }
  // detached + unref 让外部编辑器跟主进程脱钩,关闭鉴翎不会拖死编辑器
  try {
    if (process.platform === 'win32' && entry.appPath) {
      await spawnDetached(entry.appPath, [canonicalPath])
      return { ok: true, app: entry.resolved }
    }
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
    getScopedLogger('main').warn('open_in_editor_failed', { tool }, err)
    return { ok: false, reason: 'spawn_failed' as const }
  }
})

ipcMain.handle('open-path-in-finder', async (event, targetPath: unknown) => {
  assertTrustedIpcSender(event)
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    return { ok: false, reason: 'invalid_path' as const }
  }

  let canonicalPath: string
  let isDirectory = false
  try {
    canonicalPath = await realpath(targetPath)
    isDirectory = (await stat(canonicalPath)).isDirectory()
  } catch {
    return { ok: false, reason: 'path_missing' as const }
  }

  // Never call shell.openPath() on regular files or macOS executable bundles (.app/.pkg/.workflow...);
  // reveal them in Finder/Explorer instead.
  if (!isDirectory || (process.platform === 'darwin' && MACOS_EXECUTABLE_BUNDLE_RE.test(canonicalPath))) {
    shell.showItemInFolder(canonicalPath)
    return { ok: true as const }
  }

  const error = await shell.openPath(canonicalPath)
  if (error) {
    return { ok: false, reason: 'open_failed' as const, message: error }
  }
  return { ok: true as const }
})

ipcMain.handle('open-external-url', (event, targetUrl: unknown) => {
  assertTrustedIpcSender(event)
  return openExternalUrl(targetUrl)
})

// 用户设置(reverse geocoding API keys 等)— 持久化到 userData/settings.json,
// 落盘前每个 key 都过 Electron safeStorage 异步加密(macOS Keychain / Win DPAPI /
// Linux libsecret),详见 ./user-settings.ts。process-manager 启动 engine 时
// 读这个文件解密后注入 env var,保存后须 restart-engine 才生效。

ipcMain.handle('get-user-settings', async (event) => {
  assertTrustedIpcSender(event)
  return await readUserSettings()
})

ipcMain.handle('save-user-settings', async (event, partial: UserSettings) => {
  assertTrustedIpcSender(event)
  try {
    return { ok: true as const, settings: await mergeUserSettings(partial) }
  } catch (err) {
    if (err instanceof SafeStorageUnavailableError) {
      return {
        ok: false as const,
        reason: 'safe_storage_unavailable' as const,
        message: err.message,
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    getScopedLogger('main').error('save_user_settings_failed', undefined, err)
    return { ok: false as const, reason: 'unknown' as const, message }
  }
})

// 重启 engine — settings 修改后调,让新 key 生效
ipcMain.handle('restart-engine', async (event) => {
  assertTrustedIpcSender(event)
  if (processManager) {
    await processManager.restart()
  }
  return true
})

// ---- 客户端日志与诊断 IPC ----

ipcMain.on('client-log:batch', (event, entries: unknown, sourceProcess?: unknown) => {
  try {
    assertTrustedIpcSender(event)
  } catch {
    return
  }
  const proc = sourceProcess === 'preload' ? 'preload' : 'renderer'
  getClientLogger()?.ingestBatch(entries, proc)
})

ipcMain.handle('logs:get-status', (event) => {
  assertTrustedIpcSender(event)
  return buildLoggingStatusSnapshot()
})

ipcMain.handle('logs:set-consent', async (event, enabled: unknown) => {
  assertTrustedIpcSender(event)
  const allow = Boolean(enabled)
  const saved = saveLoggingPreferences({
    consent: allow ? 'enabled' : 'disabled',
    consentVersion: LOG_CONSENT_VERSION,
    enabled: allow,
  })
  const clientLog = getClientLogger()
  if (allow) {
    const device = await ensureDeviceRecord(true)
    clientLog?.setDeviceId(device.deviceId)
  }
  clientLog?.configure({
    consent: saved.consent,
    enabled: saved.enabled,
    level: saved.level,
  })
  processManager?.setStderrLoggingEnabled(saved.enabled)
  if (allow) {
    void ensureSystemProfile(false)
  }
  if (processManager) {
    await processManager.syncLoggingToEngine({
      enabled: saved.enabled,
      level: saved.level,
      deviceId: clientLog?.getDeviceId(),
      sessionId: clientLog?.getSessionId(),
    })
  }
  const snapshot = buildLoggingStatusSnapshot()
  broadcastLoggingState()
  return snapshot
})

ipcMain.handle('logs:set-enabled', async (event, enabled: unknown) => {
  assertTrustedIpcSender(event)
  const allow = Boolean(enabled)
  const saved = saveLoggingPreferences({
    consent: allow ? 'enabled' : 'disabled',
    consentVersion: LOG_CONSENT_VERSION,
    enabled: allow,
  })
  const clientLog = getClientLogger()
  if (allow) {
    const device = await ensureDeviceRecord(true)
    clientLog?.setDeviceId(device.deviceId)
  }
  clientLog?.configure({
    consent: saved.consent,
    enabled: saved.enabled,
    level: saved.level,
  })
  processManager?.setStderrLoggingEnabled(saved.enabled)
  if (allow) {
    void ensureSystemProfile(false)
  }
  if (processManager) {
    await processManager.syncLoggingToEngine({
      enabled: saved.enabled,
      level: saved.level,
      deviceId: clientLog?.getDeviceId(),
      sessionId: clientLog?.getSessionId(),
    })
  }
  const snapshot = buildLoggingStatusSnapshot()
  broadcastLoggingState()
  return snapshot
})

ipcMain.handle('logs:set-level', async (event, level: unknown) => {
  assertTrustedIpcSender(event)
  if (!isValidConfigurableLogLevel(level)) {
    throw new Error('Invalid log level')
  }
  const saved = saveLoggingPreferences({ level })
  const clientLog = getClientLogger()
  clientLog?.setLevel(saved.level)
  if (processManager) {
    await processManager.syncLoggingToEngine({
      enabled: saved.enabled,
      level: saved.level,
      deviceId: clientLog?.getDeviceId(),
      sessionId: clientLog?.getSessionId(),
    })
  }
  const snapshot = buildLoggingStatusSnapshot()
  broadcastLoggingState()
  return snapshot
})

ipcMain.handle('logs:clear', async (event): Promise<ClearLogsResult> => {
  assertTrustedIpcSender(event)
  const clientLog = getClientLogger()
  await clientLog?.drain()
  processManager?.setStderrLoggingEnabled(false)
  const result = clearLogFiles(getLogsDirPath())
  if (result.ok && clientLog?.isEnabled()) {
    processManager?.setStderrLoggingEnabled(true, true)
    if (cachedSystemProfile) {
      saveSystemProfileCache(getLogsDirPath(), cachedSystemProfile, clientLog.getDeviceId())
    }
    if (processManager) {
      await processManager.syncLoggingToEngine({
        enabled: true,
        level: clientLog.getLevel(),
        deviceId: clientLog.getDeviceId(),
        sessionId: clientLog.getSessionId(),
        reopen: true,
      })
    }
    clientLog.child('logger').info('logs_cleared', {
      freedBytes: result.freedBytes,
      removedFiles: result.removedFiles,
    })
  }
  broadcastLoggingState()
  return result
})

ipcMain.handle('logs:export-bundle', async (event): Promise<ExportDiagnosticsResult> => {
  assertTrustedIpcSender(event)
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, reason: 'unknown', message: 'Main window unavailable' }
  }
  const clientLog = getClientLogger()
  // Resolve deviceId (without persisting if logging is currently disabled).
  const device = await ensureDeviceRecord(Boolean(clientLog?.isEnabled()))
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15)
  const shortId = device.deviceId.replace(/^pl-/, '').slice(0, 8)
  const defaultFileName = `PlumeLens-logs-${shortId}-${stamp}.zip`
  const defaultDir = app.getPath('downloads') || app.getPath('desktop')

  const saveDialog = await dialog.showSaveDialog(mainWindow, {
    title: '导出诊断日志包',
    defaultPath: join(defaultDir, defaultFileName),
    buttonLabel: '导出',
    filters: [{ name: 'ZIP 诊断包', extensions: ['zip'] }],
  })
  if (saveDialog.canceled || !saveDialog.filePath) {
    return { ok: false, canceled: true, reason: 'canceled' }
  }

  try {
    await clientLog?.drain()
    const [profile, dbSummary, userSettings] = await Promise.all([
      ensureSystemProfile(true),
      processManager ? processManager.fetchEngineJson('/diagnostics/db-summary', 4000) : Promise.resolve(null),
      readUserSettings().catch(() => ({}) as UserSettings),
    ])
    const extraSecrets = [
      processManager?.getAuthToken(),
      userSettings.amapKey,
      userSettings.baiduAk,
      userSettings.tencentKey,
    ].filter((s): s is string => typeof s === 'string' && s.length >= 6)

    const result = await buildAndWriteDiagnosticsZipAsync({
      outputPath: saveDialog.filePath,
      logsDir: getLogsDirPath(),
      userDataDir: app.getPath('userData'),
      deviceId: device.deviceId,
      sessionId: clientLog?.getSessionId() ?? 'unknown',
      loggingEnabled: Boolean(clientLog?.isEnabled()),
      profile,
      dbSummary,
      extraSecrets,
    })
    clientLog?.child('diagnostics').info('diagnostics_bundle_exported', {
      sizeBytes: result.sizeBytes,
      fileCount: result.fileCount,
    })
    return {
      ok: true,
      path: saveDialog.filePath,
      sizeBytes: result.sizeBytes,
      fileCount: result.fileCount,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    getScopedLogger('diagnostics').error('diagnostics_export_failed', undefined, err)
    return { ok: false, reason: 'write_failed', message }
  }
})

// 让用户在 fatal 状态点 banner 直接打开 logs 目录(crash 自查 / 上报)
ipcMain.handle('open-logs-dir', async (event) => {
  assertTrustedIpcSender(event)
  const logsDir = getLogsDirPath()
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
    getScopedLogger('main').warn('chmod_userdata_failed', undefined, err)
  }
}

// Lifecycle
app.whenReady().then(async () => {
  if (!hasInstanceLock) return
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

  // 初始化客户端统一日志核心（未同意前绝不落盘，仅内存缓冲本次启动事件）
  const loggingPrefs = readLoggingPreferences()
  const existingDevice = readExistingDeviceId(userDataDir)
  cachedDeviceRecord = existingDevice
  const clientLog = initClientLogger({
    logsDir: getLogsDirPath(),
    deviceId: existingDevice?.deviceId ?? null,
    consent: loggingPrefs.consent,
    enabled: loggingPrefs.enabled,
    level: loggingPrefs.level,
    mirrorToStderr: !app.isPackaged || process.env['PLUMELENS_LOG_STDERR'] === '1',
  })
  const mainLog = clientLog.child('main')
  mainLog.info('app_ready', {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    loggingConsent: loggingPrefs.consent,
    loggingEnabled: loggingPrefs.enabled,
    readyMs: Date.now() - APP_BOOT_STARTED_AT,
  })
  if (loggingPrefs.enabled) {
    void ensureDeviceRecord(true).then(() => ensureSystemProfile(false))
  }

  // 监听子进程崩溃与系统休眠/过热信号（排查长任务卡顿或中断）
  app.on('child-process-gone', (_event, details) => {
    clientLog.writeCrashDump(
      'child_process_gone',
      `type=${details.type} reason=${details.reason} exitCode=${details.exitCode} service=${details.serviceName ?? ''}`,
      { type: details.type, reason: details.reason, exitCode: details.exitCode },
    )
  })
  powerMonitor.on('suspend', () => {
    clientLog.child('power').info('system_suspend')
    clientLog.drainSync()
  })
  powerMonitor.on('resume', () => {
    clientLog.child('power').info('system_resume')
  })
  if (process.platform === 'darwin') {
    powerMonitor.on('thermal-state-change', (details) => {
      clientLog.child('power').warn('thermal_state_change', { state: details.state })
    })
  }

  const thumbnailsRoot = join(userDataDir, 'derived', 'thumbnails')
  const speciesArtworkRoot = app.isPackaged
    ? join(process.resourcesPath, 'species-artwork')
    : existsSync(join(app.getAppPath(), 'resources', 'species-artwork'))
      ? join(app.getAppPath(), 'resources', 'species-artwork')
      : join(__dirname, '..', '..', 'resources', 'species-artwork')
  const thumbnailsRootResolved = resolve(thumbnailsRoot)
  const speciesArtworkRootResolved = resolve(speciesArtworkRoot)
  // 首次启动也先创建缓存目录再取真实路径。Windows 的 RUNNER~1 等短路径
  // 或目录联接会在 realpath 时展开，不能拿未展开的根与真实文件路径比较。
  let realThumbnailRootCache: string | null = null
  try {
    realThumbnailRootCache = await prepareCacheDirectory(thumbnailsRoot)
  } catch (err) {
    clientLog.child('thumb').warn('cache_initialization_failed', undefined, err)
  }
  const getRealThumbnailRoot = async (): Promise<string> => {
    if (realThumbnailRootCache) return realThumbnailRootCache
    realThumbnailRootCache = await prepareCacheDirectory(thumbnailsRoot)
    return realThumbnailRootCache
  }
  let realSpeciesArtworkRootCache: string | null = null
  try {
    realSpeciesArtworkRootCache = await realpath(speciesArtworkRoot)
    const files = await readdir(realSpeciesArtworkRootCache)
    const index = new Map<string, string>()
    // Populate in reverse priority order so earlier SPECIES_ARTWORK_EXTENSIONS win.
    for (const ext of [...SPECIES_ARTWORK_EXTENSIONS].reverse()) {
      for (const file of files) {
        if (file.endsWith(ext)) {
          index.set(file.slice(0, -ext.length), file)
        }
      }
    }
    speciesArtworkIndex = index
  } catch {
    /* 开发期未下载物种图时目录可能不存在;请求会返回 404 并由 UI 渐变兜底。 */
  }
  const getRealSpeciesArtworkRoot = async (): Promise<string> => {
    if (realSpeciesArtworkRootCache) return realSpeciesArtworkRootCache
    realSpeciesArtworkRootCache = await realpath(speciesArtworkRoot)
    return realSpeciesArtworkRootCache
  }
  mainLog.debug('paths_initialized', {
    userData: app.getPath('userData'),
    thumbnailsRoot,
    speciesArtworkRoot,
  })

  // Register CSP header handler once for the default session (avoid stacking
  // listeners on macOS window recreation).
  const isDevSession = !app.isPackaged
  let devHttpOrigin = 'http://localhost:5173'
  let devWsOrigin = 'ws://localhost:5173'
  if (isDevSession && process.env['ELECTRON_RENDERER_URL']) {
    try {
      const parsedDev = new URL(process.env['ELECTRON_RENDERER_URL'])
      devHttpOrigin = parsedDev.origin
      devWsOrigin = `${parsedDev.protocol === 'https:' ? 'wss:' : 'ws:'}//${parsedDev.host}`
    } catch {
      /* fallback to default Vite origin */
    }
  }
  const contentSecurityPolicy = isDevSession
    ? [
        `default-src 'self' ${devHttpOrigin} ${devWsOrigin};`,
        `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${devHttpOrigin};`,
        "style-src 'self' 'unsafe-inline';",
        `connect-src 'self' http://127.0.0.1:* ${devHttpOrigin} ${devWsOrigin} plumelens:;`,
        "img-src 'self' data: blob: plumelens:;",
        "font-src 'self' data:;",
      ].join(' ')
    : [
        "default-src 'self';",
        "script-src 'self';",
        "style-src 'self' 'unsafe-inline';",
        "connect-src 'self' http://127.0.0.1:* plumelens:;",
        "img-src 'self' data: blob: plumelens:;",
        "font-src 'self' data:;",
      ].join(' ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    const headers: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(details.responseHeaders ?? {})) {
      if (key.toLowerCase() === 'content-security-policy') continue
      headers[key] = value
    }
    headers['Content-Security-Policy'] = [contentSecurityPolicy]
    callback({ responseHeaders: headers })
  })

  protocol.handle('plumelens', async (request) => {
    const url = new URL(request.url)
    if (url.host === 'species-artwork') {
      let rawKey: string
      try {
        rawKey = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      } catch {
        return new Response('Bad URL', { status: 400 })
      }
      const key = normalizeSpeciesArtworkKey(rawKey)
      if (!key) return new Response('Bad artwork key', { status: 400 })
      const cachedPath = resolveCachedSpeciesArtworkPath(speciesArtworkRoot, key)
      if (!cachedPath) return new Response('Not found', { status: 404 })
      return await serveLocalCacheFile(
        cachedPath,
        speciesArtworkRootResolved,
        getRealSpeciesArtworkRoot,
        'species-artwork',
      )
    }

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
    // path.resolve + realpath 单文件确认真实落点(防 path traversal / symlink 逃逸)。
    return await serveLocalCacheFile(
      filePath,
      thumbnailsRootResolved,
      getRealThumbnailRoot,
      'thumb',
    )
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

  const sendToMain = (channel: string, payload: unknown): void => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send(channel, payload)
  }

  const sendStatus = (payload: EngineStatusPayload): void => {
    sendToMain('engine-status', payload)
  }

  processManager.on('ready', (url: string) => {
    sendStatus({ kind: 'ready', url })
    // 兼容老 channel(早期 renderer 还在用)
    sendToMain('backend-ready', url)
    // 若用户在引擎启动期间开启/切换了日志开关，在此补同步一次并补充 Engine 运行时档案
    const activeLog = getClientLogger()
    if (activeLog) {
      void processManager?.syncLoggingToEngine({
        enabled: activeLog.isEnabled(),
        level: activeLog.getLevel(),
        deviceId: activeLog.getDeviceId(),
        sessionId: activeLog.getSessionId(),
      })
      if (activeLog.isEnabled()) {
        void refreshEngineRuntimeInProfile()
      }
    }
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
    sendToMain('backend-error', msg)
  })

  createWindow()
  // Defer external editor discovery (which spawns reg.exe on Windows) off the critical boot path.
  setImmediate(() => resolveEditors())
  await processManager.start()
})

app.on('window-all-closed', () => {
  // 主窗口关闭确认后会走 app.quit();这里仅保留非 macOS 的兜底语义。
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (allowAppQuit) return
  // macOS 隐藏/最小化后从 Dock 激活时重建窗口；正常关闭已退出进程。
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

let engineShutdownComplete = false
let engineShutdownPending: Promise<void> | null = null
app.on('before-quit', (event) => {
  // 真正退出（cmd-Q / 关闭整个应用）才杀 engine。
  if (!allowAppQuit) {
    event.preventDefault()
    void requestCloseConfirmation().then((confirmed) => {
      if (!confirmed) return
      allowAppQuit = true
      app.quit()
    })
    return
  }
  if (!engineShutdownComplete) {
    event.preventDefault()
    if (!engineShutdownPending) {
      engineShutdownPending = Promise.resolve()
        .then(async () => {
          // Destroy this application's windows first so live SSE streams stop
          // holding uvicorn open before its lifespan shutdown can run.
          allowWindowClose = true
          for (const window of BrowserWindow.getAllWindows()) window.destroy()
          await processManager?.stop()
          await getClientLogger()?.drain()
          getClientLogger()?.shutdownSync('before_quit')
        })
        .finally(() => {
          engineShutdownComplete = true
          app.quit()
        })
    }
  }
})

// 兜底:Node 进程意外退出(崩溃 / 被 kill)时杀 engine。
// detached: true 的子进程不会随 Electron 死,必须显式 cleanup。
//
// process.on('exit') 触发时事件循环已停 — stop() 内部的 setTimeout 不会 fire,
// 异步 SIGTERM→SIGKILL 兜底链全部失效。这里走同步 process.kill(-pid, 'SIGKILL')
// 直接杀进程组(spawn 时 detached:true,pgid == pid)。
process.on('exit', () => {
  getClientLogger()?.drainSync()
  for (const pid of processManager?.getEnginePids() ?? []) {
    try {
      forceTerminateEngineTreeSync(pid)
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
  const logger = getClientLogger()
  if (logger) {
    logger.writeCrashDump('uncaught_exception', `${err.message}\n${err.stack ?? ''}`)
  } else {
    process.stderr.write(`[main] uncaughtException: ${err.message}\n${err.stack ?? ''}\n`)
  }
  try {
    processManager?.stop()
  } catch {
    /* ignore — best effort */
  }
  quitWithoutConfirmation()
})
process.on('unhandledRejection', (reason) => {
  getScopedLogger('main').error('unhandled_rejection', undefined, reason)
})

process.on('SIGTERM', () => {
  processManager?.stop()
  quitWithoutConfirmation()
})
process.on('SIGINT', () => {
  processManager?.stop()
  quitWithoutConfirmation()
})
