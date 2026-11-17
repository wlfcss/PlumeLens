import { win32, posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isWithinDirectory } from '../../electron/cache-paths'

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
})
