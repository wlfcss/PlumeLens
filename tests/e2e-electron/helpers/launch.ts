/**
 * E2E Electron launch + fixture helpers.
 *
 * 关键设计:每个 test suite 自己分配 tmp data dir 通过 --user-data-dir 隔离,
 * 不污染用户真实 ~/Library/Application Support/plumelens。Electron 会把这个值
 * 用作 app.getPath('userData'),engine 子进程从 PLUMELENS_DATA_DIR env var 读
 * 同一目录(process-manager.ts:184)。
 */
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const REPO_ROOT = join(__dirname, '..', '..', '..')
export const APP_PATH = join(
  REPO_ROOT,
  'release',
  'mac-arm64',
  'PlumeLens.app',
  'Contents',
  'MacOS',
  'PlumeLens',
)
export const FIXTURE_PHOTOS_DIR = join(
  REPO_ROOT,
  'tests',
  'e2e-electron',
  'fixtures',
  'sample_photos',
)

export interface LaunchHandle {
  app: ElectronApplication
  page: Page
  dataDir: string
}

export interface LaunchOptions {
  disableCloseConfirm?: boolean
}

/**
 * 创一个新的 tmp data dir(每次 launchFresh 一个独立目录,模拟全新安装)。
 * 调用方负责 cleanup(app.close 后 cleanupDataDir(dir))。
 */
export function makeTmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'plumelens-e2e-'))
}

export function cleanupDataDir(dir: string): void {
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      console.warn(`[e2e] failed to cleanup ${dir}:`, err)
    }
  }
}

/**
 * Launch packaged Electron app pointing at a custom data dir.
 *
 * --user-data-dir 是 Electron/Chromium 的内置 CLI flag,会让 app.getPath('userData')
 * 返回这个值,主进程 process-manager 会把它作为 PLUMELENS_DATA_DIR 注入 engine env。
 * 整个 app + engine 子进程都跑在隔离目录里,完全和用户真实数据无关。
 */
export async function launchApp(
  dataDir: string,
  options: LaunchOptions = {},
): Promise<LaunchHandle> {
  const disableCloseConfirm = options.disableCloseConfirm ?? true
  const app = await _electron.launch({
    executablePath: APP_PATH,
    args: [`--user-data-dir=${dataDir}`],
    env: {
      ...process.env,
      // 防止 engine lifespan 的 _kill_orphan_engines 通过 pgrep -f 误杀用户正在跑
      // 的 PlumeLens engine(那个 engine 跑在不同 data dir,但 binary 名一致)。
      PLUMELENS_SKIP_ORPHAN_KILL: '1',
      // 默认自动化关闭应用时跳过二次确认;需要覆盖真实确认弹窗的 spec 可显式关闭。
      ...(disableCloseConfirm ? { PLUMELENS_E2E_DISABLE_CLOSE_CONFIRM: '1' } : {}),
    },
    timeout: 30_000,
  })
  // stdout/stderr 透出来便于 CI 失败时定位
  app.process().stdout?.on('data', (d) => process.stdout.write(`[main] ${d}`))
  app.process().stderr?.on('data', (d) => process.stderr.write(`[main:err] ${d}`))

  const page = await app.firstWindow({ timeout: 30_000 })
  await page.waitForLoadState('domcontentloaded')
  // 等 React 挂上(brand mark 出现 = React tree mounted)
  await expect(page.getByText('鉴翎').first()).toBeVisible({ timeout: 30_000 })
  return { app, page, dataDir }
}

/**
 * 等 engine 子进程 ready 的超时,对齐产品侧 `BACKEND_BOOT_TIMEOUT_MS`
 * (renderer/src/lib/api-client.ts)的 60s —— 测试不该比产品本身更严格。
 *
 * 原值 30s 的依据是本机实测(PyInstaller bundle 自解压 + 5 个模型加载约 7s),
 * 但 GitHub macos runner 磁盘/CPU 慢 4-5 倍:v0.7.6 tag 构建有 4 个用例栽在
 * 这个阈值上,而同一份 DMG 本机 6/6 通过、engine ready 只要 7.1s。
 */
const ENGINE_READY_TIMEOUT_MS = 60_000
const ENGINE_READY_POLL_MS = 500

/**
 * 超时时把 engine 侧线索带进报错。
 *
 * 只报 "URL never resolved" 区分不出「还在慢慢起」「起来了又崩了」「压根没 spawn」,
 * 而 CI 失败时不会执行 upload-artifact,日志就彻底断了 —— 必须让异常自己带上下文。
 */
function engineDiagnostics(dataDir?: string): string {
  if (!dataDir) return '(no dataDir given; cannot locate engine logs)'
  const logsDir = join(dataDir, 'logs')
  if (!existsSync(logsDir)) {
    return `(no logs dir at ${logsDir} — engine likely never spawned)`
  }
  try {
    const files = readdirSync(logsDir).filter(
      (name) => name.startsWith('engine.stderr') || name === 'engine.jsonl' || name === 'electron.log',
    )
    if (files.length === 0) return `(logs dir ${logsDir} is empty)`
    return files
      .map((name) => {
        const tail = readFileSync(join(logsDir, name), 'utf8').split('\n').slice(-30).join('\n')
        return `--- ${name} (last 30 lines) ---\n${tail}`
      })
      .join('\n')
  } catch (err) {
    return `(failed to read engine logs: ${String(err)})`
  }
}

/**
 * 等 engine 子进程 ready + IPC 能拿到 backendUrl。
 *
 * 传 dataDir 可在超时的报错里附上 engine 日志尾部,CI 上定位失败全靠它。
 */
export async function waitForEngineReady(page: Page, dataDir?: string): Promise<string> {
  const deadline = Date.now() + ENGINE_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const url = await page.evaluate(async () => {
      const w = window as unknown as {
        plumelens?: { getBackendUrl: () => Promise<string | null> }
      }
      return (await w.plumelens?.getBackendUrl()) ?? null
    })
    if (url) return url
    await new Promise((r) => setTimeout(r, ENGINE_READY_POLL_MS))
  }
  throw new Error(
    `Engine URL never resolved within ${ENGINE_READY_TIMEOUT_MS / 1000}s\n` +
      engineDiagnostics(dataDir),
  )
}

/**
 * 通过 preload 的 engineRequest 调 engine API(走真鉴权链路,token 不暴露给 renderer)。
 */
export async function callEngine(
  page: Page,
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  return page.evaluate(
    async ({ path, init }) => {
      const w = window as unknown as {
        plumelens?: {
          engineRequest?: (
            p: string,
            i?: { method?: string; body?: string | null; headers?: Record<string, string> },
          ) => Promise<{ ok: boolean; status: number; body: string }>
        }
      }
      if (!w.plumelens?.engineRequest) throw new Error('preload engineRequest not available')
      return w.plumelens.engineRequest(path, init)
    },
    { path, init },
  )
}

/**
 * 调真 /library/import 把 fixture sample_photos 目录扫进 db。
 * 返回新建 library 的 summary。
 */
export async function importFixtureLibrary(
  page: Page,
  rootPath: string = FIXTURE_PHOTOS_DIR,
  displayName: string = 'e2e-fixture-lib',
): Promise<{ id: string; display_name: string }> {
  const res = await callEngine(page, '/library/import', {
    method: 'POST',
    body: JSON.stringify({ root_path: rootPath, display_name: displayName, recursive: true }),
  })
  if (!res.ok) throw new Error(`/library/import failed: ${res.status} ${res.body}`)
  return JSON.parse(res.body) as { id: string; display_name: string }
}

/**
 * Wait until library status becomes 'ready' (扫描 + companion backfill 完成)。
 * 不等分析完成 — 分析对 e2e 不是必需(birds=0 也能验证 UI 链路通)。
 */
export async function waitForLibraryReady(
  page: Page,
  libraryId: string,
  timeoutMs: number = 30_000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await callEngine(page, `/library/${libraryId}`)
    if (res.ok) {
      const detail = JSON.parse(res.body) as {
        library: { status: string; total_count: number }
      }
      if (detail.library.status === 'ready' && detail.library.total_count > 0) return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Library ${libraryId} not ready within ${timeoutMs}ms`)
}
