import { win32, posix } from 'node:path'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { isWithinDirectory, prepareCacheDirectory } from '../../electron/cache-paths'

describe('local image cache containment', () => {
  it('accepts Windows child paths, Unicode and case-insensitive drive names', () => {
    expect(
      isWithinDirectory('C:\\Cache\\缩略图', 'c:\\cache\\缩略图\\grid\\photo.jpg', win32),
    ).toBe(true)
    expect(
      isWithinDirectory(
        '\\\\server\\photos\\cache',
        '\\\\server\\photos\\cache\\grid\\photo.jpg',
        win32,
      ),
    ).toBe(true)
  })
  it('rejects sibling-prefix, parent traversal and different-drive escapes', () => {
    for (const target of ['C:\\cache-other\\a.jpg', 'C:\\cache\\..\\a.jpg', 'D:\\cache\\a.jpg']) {
      expect(isWithinDirectory('C:\\cache', target, win32)).toBe(false)
    }
    expect(isWithinDirectory('/cache', '/cache-other/a.jpg', posix)).toBe(false)
    expect(isWithinDirectory('/cache', '/cache/../a.jpg', posix)).toBe(false)
  })
  it('keeps POSIX cache paths functional', () => {
    expect(isWithinDirectory('/cache', '/cache/grid/a.jpg', posix)).toBe(true)
  })
  it('canonicalizes a new cache under an aliased parent before checking real files', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'plumelens-cache-alias-'))
    try {
      const parent = join(workspace, 'actual-profile')
      const alias = join(workspace, 'profile-alias')
      mkdirSync(parent)
      symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const cache = join(alias, 'derived', 'thumbnails')
      const canonical = await prepareCacheDirectory(cache)
      const actualCache = join(parent, 'derived', 'thumbnails')
      expect(canonical).toBe(await realpath(actualCache))

      const thumbnail = join(actualCache, 'photo.jpg')
      const outside = join(parent, 'outside.jpg')
      writeFileSync(thumbnail, '')
      writeFileSync(outside, '')
      expect(isWithinDirectory(canonical, await realpath(join(cache, 'photo.jpg')))).toBe(true)
      expect(isWithinDirectory(canonical, await realpath(outside))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
