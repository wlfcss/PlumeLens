import { cleanup, render, waitFor, within } from '@testing-library/react'
import React, { useCallback, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { useResponsiveGridLayout } from '@/lib/virtual-grid'

afterEach(cleanup)

function ResponsiveGridProbe({
  visible,
  width = 430,
}: {
  visible: boolean
  width?: number
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const setMeasuredNode = useCallback(
    (next: HTMLDivElement | null) => {
      if (next) {
        Object.defineProperty(next, 'clientWidth', {
          configurable: true,
          value: width,
        })
      }
      setNode(next)
    },
    [width],
  )
  const layout = useResponsiveGridLayout(node, 100, 10)

  return (
    <>
      <output data-testid="layout">
        {layout.columns}:{layout.width}
      </output>
      {visible ? <div data-testid="grid" ref={setMeasuredNode} /> : null}
    </>
  )
}

describe('useResponsiveGridLayout', () => {
  it('measures a container that mounts after an empty first render', async () => {
    const view = render(<ResponsiveGridProbe visible={false} />)
    const layout = () => within(view.container).getByTestId('layout')

    expect(layout()).toHaveTextContent('1:100')

    view.rerender(<ResponsiveGridProbe visible />)

    await waitFor(() => {
      expect(layout()).toHaveTextContent('4:430')
    })
  })

  it('resets to the minimum layout when the container unmounts', async () => {
    const view = render(<ResponsiveGridProbe visible />)
    const layout = () => within(view.container).getByTestId('layout')

    await waitFor(() => {
      expect(layout()).toHaveTextContent('4:430')
    })

    view.rerender(<ResponsiveGridProbe visible={false} />)

    await waitFor(() => {
      expect(layout()).toHaveTextContent('1:100')
    })
  })
})
