// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { findWindowsEditor } from '../../electron/windows-editors'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('finds the latest Photoshop in Program Files paths with spaces and Unicode', () => {
  const root = mkdtempSync(join(tmpdir(), 'PlumeLens 编辑器 '))
  roots.push(root)
  for (const version of ['2025', '2026']) {
    const dir = join(root, 'Adobe', `Adobe Photoshop ${version}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Photoshop.exe'), '')
  }
  expect(findWindowsEditor('photoshop', [root])).toBe(
    join(root, 'Adobe', 'Adobe Photoshop 2026', 'Photoshop.exe'),
  )
})

it('finds Topaz without using macOS app bundles', () => {
  const root = mkdtempSync(join(tmpdir(), 'PlumeLens Editors '))
  roots.push(root)
  const dir = join(root, 'Topaz Labs LLC', 'Topaz Photo AI')
  mkdirSync(dir, { recursive: true })
  const executable = join(dir, 'Topaz Photo AI.exe')
  writeFileSync(executable, '')
  expect(findWindowsEditor('topaz', [root])).toBe(executable)
})
