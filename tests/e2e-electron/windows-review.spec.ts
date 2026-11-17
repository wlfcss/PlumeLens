import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { launchApp, waitForEngineReady, callEngine, REPO_ROOT } from './helpers/launch.js'

test('Windows: real library filters, full preview, keyboard grading and restore', async () => {
  test.skip(
    process.platform !== 'win32' || !process.env.PLUMELENS_REVIEW_DATA_DIR,
    'Requires the isolated 300-photo validation library',
  )
  test.setTimeout(180_000)
  const dataDir = process.env.PLUMELENS_REVIEW_DATA_DIR!
  const libraryId = process.env.PLUMELENS_REVIEW_LIBRARY_ID!
  const { app, page } = await launchApp(dataDir)
  let restore: { id: string; decision: string | null } | undefined
  try {
    await waitForEngineReady(page, dataDir)
    const query = async (filters: Record<string, unknown>) => {
      const response = await callEngine(page, `/library/${libraryId}/selection/query`, {
        method: 'POST',
        body: JSON.stringify(filters),
      })
      expect(response.ok, response.body).toBe(true)
      return JSON.parse(response.body)
    }
    const all = await query({
      grades: ['select', 'usable', 'record', 'reject'],
      include_no_bird: true,
    })
    expect(all.matched_count).toBe(300)
    const union = new Set<string>()
    for (const [grade, expected] of Object.entries({
      select: 21,
      usable: 223,
      record: 30,
      reject: 22,
    })) {
      const result = await query({ grades: [grade] })
      expect(result.matched_count).toBe(expected)
      for (const id of result.matched_photo_ids) union.add(id)
    }
    const noBird = await query({ grades: [], include_no_bird: true })
    expect(noBird.matched_count).toBe(4)
    for (const id of noBird.matched_photo_ids) union.add(id)
    expect(union.size).toBe(300)
    const search = await query({
      grades: ['select', 'usable', 'record', 'reject'],
      include_no_bird: true,
      photo_query: '5Y3A1349.JPG',
    })
    expect(search.matched_count).toBe(1)
    const flying = await query({
      grades: ['select', 'usable', 'record', 'reject'],
      only_flying: true,
    })
    expect(flying.matched_count).toBeGreaterThan(0)
    expect(flying.matched_count).toBeLessThanOrEqual(296)

    await page.getByText('Windows 鸟片测试').first().click()
    const tile = page
      .locator('[data-photo-id]')
      .filter({ has: page.locator('button.photo-preview') })
      .first()
    const id = (await tile.getAttribute('data-photo-id'))!
    const previous = await callEngine(page, `/decisions/photo/${id}`)
    expect(previous.ok, previous.body).toBe(true)
    restore = { id, decision: JSON.parse(previous.body).decision }
    await tile.locator('button.photo-preview').dblclick()
    const dialog = page.locator('dialog[open]')
    await expect(dialog).toBeVisible()
    const previewSize = await dialog.locator('.review-image--primary').evaluate(async (element) => {
      const background = getComputedStyle(element).backgroundImage
      const url = background.match(/^url\("?(.*?)"?\)$/)?.[1]
      if (!url) throw new Error(`Missing preview background: ${background}`)
      const image = new Image()
      image.src = url
      await image.decode()
      return Math.max(image.naturalWidth, image.naturalHeight)
    })
    expect(previewSize).toBeGreaterThanOrEqual(1000)
    await page.screenshot({ path: join(REPO_ROOT, '.tools', 'windows-review-screen.png') })
    await page.keyboard.press('4')
    await expect
      .poll(
        async () => JSON.parse((await callEngine(page, `/decisions/photo/${id}`)).body).decision,
      )
      .toBe('reject')
    await page.keyboard.press('1')
    await expect
      .poll(
        async () => JSON.parse((await callEngine(page, `/decisions/photo/${id}`)).body).decision,
      )
      .toBe('select')
    await page.keyboard.press('ArrowRight')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
  } finally {
    if (restore) {
      const response = await callEngine(page, `/decisions/photo/${restore.id}`, {
        method: 'PUT',
        body: JSON.stringify({ decision: restore.decision }),
      })
      expect(response.ok, response.body).toBe(true)
    }
    await app.close()
  }
})
