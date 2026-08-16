/**
 * E2E:打包应用冷启动与历史加载。
 *
 * 这是"装新 dmg → 打开看到历史"的核心 smoke test。今天用户踩的两个 P0 都直接对应:
 * - useLibraries 在 engine cold start 5s 窗口内 retry=1 失败永久卡死
 * - /health AttributeError race
 *
 * 测试矩阵:
 *   1. 全新 data dir → 启动 → engine ready → 看到 start screen empty 状态(无 crash)
 *   2. 已有 data + library → 重启 → start screen 立刻显示 library + "继续上次文件夹"激活
 *      ↑ 这条就是今天的回归测试,装新版本必须通过才能交付。
 *   3. 选片屏 → folder 切换 → 看到 fixture photos
 *
 * 启动隔离:每个 test 启动 Electron 时传 `--user-data-dir=<tmp>`,数据完全和用户
 * 真实 ~/Library/Application Support/plumelens/ 隔离;app.close 后清理 tmp dir。
 */
import { expect, test } from '@playwright/test'
import {
  cleanupDataDir,
  importFixtureLibrary,
  launchApp,
  makeTmpDataDir,
  waitForEngineReady,
  waitForLibraryReady,
  type LaunchHandle,
} from './helpers/launch.js'

test.describe('Cold start - fresh data dir (新装首次打开)', () => {
  let dataDir: string
  let handle: LaunchHandle | null = null

  test.beforeAll(() => {
    dataDir = makeTmpDataDir()
  })

  test.afterAll(async () => {
    await handle?.app.close().catch(() => {})
    cleanupDataDir(dataDir)
  })

  test('启动可见 + engine ready + 引擎状态显示已就绪', async () => {
    handle = await launchApp(dataDir)
    const url = await waitForEngineReady(handle.page, handle.dataDir)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    // 状态栏显示"本地引擎就绪"(engineState='ready' + pipeline.ready=true)
    await expect(handle.page.getByText(/本地引擎就绪/).first()).toBeVisible({ timeout: 15_000 })
  })

  test('start screen 主按钮可点 + 无最近文件夹时不渲染列表', async () => {
    if (!handle) throw new Error('handle not initialized from previous test')
    // "选择照片文件夹" 主按钮
    await expect(handle.page.getByRole('button', { name: /选择照片文件夹/ })).toBeVisible()
    // "继续上次文件夹" 在 empty state 下应该 disabled
    const continueBtn = handle.page.getByRole('button', { name: /继续上次文件夹/ })
    await expect(continueBtn).toBeDisabled()
    // 最近文件夹 section 不渲染(无 library)
    await expect(handle.page.getByText('最近文件夹')).toHaveCount(0)
  })
})

test.describe('Cold start - persisted history (装新版后的回归测试)', () => {
  // 关键:这两个 test 共用同一个 dataDir,模拟"用户上次用过 → 关闭 → 装新版本 → 重新打开"。
  // 正是今天用户踩的场景:db 里有 library 但前端不显示。
  let dataDir: string

  test.beforeAll(() => {
    dataDir = makeTmpDataDir()
  })

  test.afterAll(() => {
    cleanupDataDir(dataDir)
  })

  test('Phase 1 — import fixture library → 等 ready → quit', async () => {
    const handle = await launchApp(dataDir)
    try {
      await waitForEngineReady(handle.page, handle.dataDir)

      const lib = await importFixtureLibrary(handle.page)
      expect(lib.id).toMatch(/[0-9a-f-]{36}/)
      expect(lib.display_name).toBe('e2e-fixture-lib')

      await waitForLibraryReady(handle.page, lib.id, 30_000)
    } finally {
      await handle.app.close()
    }
  })

  test('Phase 2 — relaunch same data dir → 历史 library 立刻可见(P0 回归)', async () => {
    const handle = await launchApp(dataDir)
    try {
      await waitForEngineReady(handle.page, handle.dataDir)

      // 关键断言:start screen 必须显示 library 名字 + "继续上次文件夹"激活。
      // 失败时正是装新 dmg 看不到历史的复现 — 今天踩的两个 P0 都会让这条挂。
      await expect(handle.page.getByText('最近文件夹').first()).toBeVisible({
        timeout: 15_000,
      })
      await expect(handle.page.getByText('e2e-fixture-lib').first()).toBeVisible({
        timeout: 15_000,
      })
      const continueBtn = handle.page.getByRole('button', { name: /继续上次文件夹/ })
      await expect(continueBtn).toBeEnabled()
    } finally {
      await handle.app.close()
    }
  })

  test('Phase 3 — 进入选片屏 → fixture photos 加载', async () => {
    const handle = await launchApp(dataDir)
    try {
      await waitForEngineReady(handle.page, handle.dataDir)
      // 等首页 library 出现再切选片(否则可能因 list 还没 ready 导致 navigate 后空)
      await expect(handle.page.getByText('e2e-fixture-lib').first()).toBeVisible({
        timeout: 15_000,
      })

      await handle.page.getByRole('button', { name: '选片', exact: true }).click()

      // selection 屏的 sidebar 应有 folder 项
      await expect(handle.page.getByText('e2e-fixture-lib').first()).toBeVisible({
        timeout: 10_000,
      })

      // photos 网格不能空 — fixture 5 张应该都扫进来 + 显示在 selection 屏。
      // .photo-preview 是 PhotoTile 的容器(app.css 有定义)。
      // 一条 spec 内 photos 可能因为 hash 异步还没全部入库,容忍 ≥1 张。
      await expect(async () => {
        const count = await handle.page.locator('.photo-preview').count()
        expect(count).toBeGreaterThan(0)
      }).toPass({ timeout: 30_000 })
    } finally {
      await handle.app.close()
    }
  })

  test('Phase 4 — close prompt 确认后退出进程 → 同 data dir 重启初始化正常', async () => {
    const handle = await launchApp(dataDir, { disableCloseConfirm: false })
    const childProcess = handle.app.process()
    const exited = new Promise<void>((resolve) => {
      if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
        resolve()
        return
      }
      childProcess.once('exit', () => resolve())
    })

    await waitForEngineReady(handle.page, handle.dataDir)

    const promptWindow = handle.app.waitForEvent('window', { timeout: 10_000 })
    await handle.app.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
      mainWindow?.close()
    })

    const prompt = await promptWindow
    await prompt.waitForLoadState('domcontentloaded')
    await expect(prompt.getByText('确定要退出鉴翎吗？')).toBeVisible()
    await expect(prompt.getByText(/本地引擎会停止/)).toBeVisible()
    await prompt.getByRole('link', { name: '退出' }).click()

    await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('app did not exit after close confirmation')), 15_000),
      ),
    ])

    const relaunched = await launchApp(dataDir)
    try {
      await waitForEngineReady(relaunched.page, relaunched.dataDir)
      await expect(relaunched.page.getByText('最近文件夹').first()).toBeVisible({
        timeout: 15_000,
      })
      await expect(relaunched.page.getByText('e2e-fixture-lib').first()).toBeVisible({
        timeout: 15_000,
      })
      await expect(relaunched.page.getByRole('button', { name: /继续上次文件夹/ })).toBeEnabled()
    } finally {
      await relaunched.app.close()
    }
  })
})
