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
import { mkdtempSync, rmSync, existsSync } from 'fs'
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
export async function launchApp(dataDir: string): Promise<LaunchHandle> {
  const app = await _electron.launch({
    executablePath: APP_PATH,
    args: [`--user-data-dir=${dataDir}`],
    env: {
      ...process.env,
      // 防止 engine lifespan 的 _kill_orphan_engines 通过 pgrep -f 误杀用户正在跑
      // 的 PlumeLens engine(那个 engine 跑在不同 data dir,但 binary 名一致)。
      PLUMELENS_SKIP_ORPHAN_KILL: '1',
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
 * 等 engine 子进程 ready + IPC 能拿到 backendUrl。
 *
 * 60 retries × 500ms = 30s timeout。PyInstaller bundle 自解压 + 5 个模型加载实测
 * 5-8s,30s 留足余量。
 */
export async function waitForEngineReady(page: Page): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const url = await page.evaluate(async () => {
      const w = window as unknown as {
        plumelens?: { getBackendUrl: () => Promise<string | null> }
      }
      return (await w.plumelens?.getBackendUrl()) ?? null
    })
    if (url) return url
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Engine URL never resolved within 30s')
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
