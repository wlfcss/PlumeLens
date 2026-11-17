import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, waitForEngineReady, REPO_ROOT } from './helpers/launch.js'

test('Windows: native dark caption, actual CJK font and compact window layout', async () => {
  test.skip(
    process.platform !== 'win32' || !process.env.PLUMELENS_REVIEW_DATA_DIR,
    'Requires a Windows validation library',
  )
  test.setTimeout(180_000)
  const scale = process.env.PLUMELENS_E2E_SCALE ?? '1'
  const { app, page } = await launchApp(process.env.PLUMELENS_REVIEW_DATA_DIR!, {
    extraArgs: [`--force-device-scale-factor=${scale}`],
  })
  try {
    await waitForEngineReady(page)
    await expect(page.locator('html')).toHaveAttribute('data-platform', 'win32')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument')
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '.brand-mark__copy span',
    })
    const fonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
    expect(fonts.fonts.some((font: { familyName: string }) => /YaHei/i.test(font.familyName))).toBe(
      true,
    )
    expect(
      fonts.fonts.some((font: { familyName: string }) => /SimSun|NSimSun/i.test(font.familyName)),
    ).toBe(false)
    writeFileSync(
      join(REPO_ROOT, '.tools', `windows-fonts-${scale}.json`),
      JSON.stringify(fonts, null, 2),
    )
    await page.getByText('Windows 鸟片测试').first().click()
    await expect(page.locator('.folder-heading-main')).toBeVisible()
    const measurements = []
    for (const [width, height] of [
      [1680, 1040],
      [1366, 768],
      [1280, 800],
      [1100, 700],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, bounds) => {
          const window = BrowserWindow.getAllWindows()[0]
          window.setBounds(bounds)
          window.show()
        },
        { width, height },
      )
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      const metrics = await page.evaluate(() => {
        const header = document.querySelector('.command-bar')!
        const actions = document.querySelector('.command-actions')!.getBoundingClientRect()
        const overlay = (
          navigator as Navigator & {
            windowControlsOverlay?: { getTitlebarAreaRect(): DOMRect; visible: boolean }
          }
        ).windowControlsOverlay
        const area = overlay?.getTitlebarAreaRect()
        return {
          width: innerWidth,
          height: innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          headerHeight: header.getBoundingClientRect().height,
          controlsVisible: overlay?.visible,
          freeAreaRight: area ? area.x + area.width : innerWidth - 138,
          actionsRight: actions.right,
          headingWidth: document.querySelector('.folder-heading-main')!.getBoundingClientRect()
            .width,
        }
      })
      expect(metrics.controlsVisible).toBe(true)
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width)
      expect(metrics.actionsRight).toBeLessThanOrEqual(metrics.freeAreaRight)
      expect(metrics.headerHeight).toBe(56)
      expect(metrics.headingWidth).toBeGreaterThanOrEqual(200)
      measurements.push(metrics)
      await page.screenshot({
        path: join(REPO_ROOT, '.tools', `windows-layout-${scale}-${width}.png`),
      })
    }
    writeFileSync(
      join(REPO_ROOT, '.tools', `windows-layout-${scale}.json`),
      JSON.stringify(measurements, null, 2),
    )
    if (Number(scale) > 1) {
      await expect
        .poll(() =>
          page
            .locator('img.photo-preview__image')
            .first()
            .evaluate((image) => (image as HTMLImageElement).currentSrc),
        )
        .toContain('/preview/')
    }
    const native = await app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const bounds = window.getBounds()
      const scale = screen.getDisplayMatching(bounds).scaleFactor
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: {
          width: Math.round(bounds.width * scale),
          height: Math.round(bounds.height * scale),
        },
      })
      return sources
        .find((source) => source.id === window.getMediaSourceId())
        ?.thumbnail.toDataURL()
    })
    if (native)
      writeFileSync(
        join(REPO_ROOT, '.tools', `windows-native-frame-${scale}.png`),
        Buffer.from(native.split(',')[1], 'base64'),
      )
  } finally {
    await app.close()
  }
})
