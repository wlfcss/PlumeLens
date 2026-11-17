import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ThumbnailImage } from '@/components/thumbnail-image'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('retries the high DPI preview as well as the grid after an early missing resource', () => {
  vi.useFakeTimers()
  const status = vi.fn()
  render(
    <ThumbnailImage
      alt="RAW preview"
      photoId="photo-1"
      src="plumelens://thumb/grid/photo-1.jpg"
      highResSrc="plumelens://thumb/preview/photo-1.jpg"
      onStatusChange={status}
    />,
  )
  const image = screen.getByRole('img')
  fireEvent.error(image)
  expect(status).toHaveBeenCalledWith('photo-1', 'error')
  act(() => vi.advanceTimersByTime(600))
  expect(image.getAttribute('srcset')).toContain('preview/photo-1.jpg?retry=1')
  fireEvent.load(image)
  expect(status).toHaveBeenLastCalledWith('photo-1', 'loaded')
})
