import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveSurvivingAnchorPhotoId,
  useSelectionScrollState,
} from '@/components/selection-chrome/use-selection-scroll-state'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('selection scroll anchor and focus fallback', () => {
  it('keeps the preferred photo when still present and picks the nearest surviving neighbor when filtered out', () => {
    const prev = ['p1', 'p2', 'p3', 'p4', 'p5']
    expect(resolveSurvivingAnchorPhotoId(prev, ['p2', 'p3', 'p5'], 'p3')).toBe('p3')
    // p3 filtered out -> prefers nearest forward neighbor p4, then backward p2
    expect(resolveSurvivingAnchorPhotoId(prev, ['p1', 'p2', 'p4', 'p5'], 'p3')).toBe('p4')
    expect(resolveSurvivingAnchorPhotoId(prev, ['p1', 'p2', 'p5'], 'p3')).toBe('p2')
    // Tail photo filtered out -> falls back backward to p4
    expect(resolveSurvivingAnchorPhotoId(prev, ['p1', 'p4'], 'p5')).toBe('p4')
    // Empty result -> null
    expect(resolveSurvivingAnchorPhotoId(prev, [], 'p3')).toBeNull()
  })

  it('preserves scroll position across sort/view changes in the same folder and restores saved scroll across folders', () => {
    const node = document.createElement('div')
    Object.defineProperty(node, 'scrollHeight', { value: 4000, configurable: true })
    Object.defineProperty(node, 'clientHeight', { value: 800, configurable: true })
    node.scrollTo = vi.fn(({ top }: ScrollToOptions = {}) => {
      if (typeof top === 'number') node.scrollTop = top
    }) as unknown as typeof node.scrollTo

    const { result, rerender } = renderHook(
      ({ folderKey, layoutKey }) => useSelectionScrollState(folderKey, layoutKey),
      { initialProps: { folderKey: 'folder-a', layoutKey: 'grouped:score' } },
    )

    act(() => {
      result.current.setSelectionScrollNode(node)
    })

    // User scrolls folder-a to 640px
    act(() => {
      node.scrollTop = 640
      node.dispatchEvent(new Event('scroll'))
    })

    // Changing sort within the same folder must NOT reset scrollTop to 0
    rerender({ folderKey: 'folder-a', layoutKey: 'grouped:shot_at' })
    expect(node.scrollTop).toBe(640)

    // Switching to an unvisited folder-b starts at 0
    rerender({ folderKey: 'folder-b', layoutKey: 'grouped:shot_at' })
    expect(node.scrollTop).toBe(0)

    // Returning to folder-a restores 640px
    rerender({ folderKey: 'folder-a', layoutKey: 'grouped:shot_at' })
    expect(node.scrollTop).toBe(640)
  })
})
