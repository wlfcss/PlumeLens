import React, { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { ReviewModal, type ReviewSaveFeedback } from '@/components/review/review-modal'
import { api } from '@/lib/api-client'
import { describePhotoGradeExplanation } from '@/lib/review-grade-explanation'
import type { PhotoGrade, PhotoRecord } from '@/lib/workspace-types'

const t = i18n.getFixedT('zh-CN')
const clients: QueryClient[] = []
const dialogMethods = ['showModal', 'close'] as const
const originalDialog = dialogMethods.map((key) =>
  Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, key),
)

function makePhoto(
  overrides: Partial<PhotoRecord> & { id: string; fileName: string; shotAt: string },
): PhotoRecord {
  const { id, fileName, shotAt, ...rest } = overrides
  return {
    id,
    folderId: 'folder-1',
    groupId: 'group-1',
    fileName,
    shotAt,
    speciesName: '白鹭',
    speciesLatinName: 'Egretta garzetta',
    speciesCandidates: [],
    speciesSource: 'model',
    manualSpecies: false,
    isNewSpecies: false,
    birdCount: 1,
    analysisStatus: 'done',
    grade: 'usable',
    decision: null,
    finalScore: 0.72,
    semanticScore: 0.72,
    technicalScore: 0.72,
    poseTags: ['perched'],
    problemTags: [],
    bestBbox: { x1: 100, y1: 100, x2: 300, y2: 300, confidence: 0.95 },
    imageWidth: 1000,
    imageHeight: 800,
    thumbPreviewUrl: `plumelens://thumb/preview/${id}.jpg`,
    thumbGridUrl: `plumelens://thumb/grid/${id}.jpg`,
    boxes: [],
    caption: '',
    previewGradient: 'linear-gradient(135deg, #1b2838, #2a475e)',
    reviewRevision: `rev-${id}`,
    ...rest,
  } as PhotoRecord
}

function setupModalEnv() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false
      },
    },
  })
  vi.spyOn(api, 'photoReview').mockImplementation(() => new Promise(() => {}))
}

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  dialogMethods.forEach((key, index) => {
    const descriptor = originalDialog[index]
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, key)
  })
})

describe('ReviewModal grade explanation, request-bound feedback and A/B compare', () => {
  it('explains manual override, pose downgrade/upgrade, no-bird and failed states', () => {
    const headMissing = makePhoto({
      id: 'p-head',
      fileName: 'HEAD.JPG',
      shotAt: '2026-11-22T09:00:00Z',
      grade: 'record',
      finalScore: 0.8,
    })
    expect(
      describePhotoGradeExplanation(headMissing, { head_visible: false, eye_visible: false }, t)
        .kind,
    ).toBe('pose_downgrade_head')

    const flyingBoost = makePhoto({
      id: 'p-fly',
      fileName: 'FLY.JPG',
      shotAt: '2026-11-22T09:00:01Z',
      grade: 'select',
      finalScore: 0.68,
    })
    expect(
      describePhotoGradeExplanation(
        flyingBoost,
        { head_visible: true, eye_visible: true, posture: 'flying' },
        t,
      ).kind,
    ).toBe('pose_upgrade_flying')

    const manual = makePhoto({
      id: 'p-manual',
      fileName: 'MANUAL.JPG',
      shotAt: '2026-11-22T09:00:02Z',
      grade: 'usable',
      decision: 'select',
      finalScore: 0.66,
    })
    expect(describePhotoGradeExplanation(manual, null, t).kind).toBe('manual_override')

    const noBird = makePhoto({
      id: 'p-empty',
      fileName: 'EMPTY.JPG',
      shotAt: '2026-11-22T09:00:03Z',
      birdCount: 0,
      grade: 'reject',
      finalScore: null,
    })
    expect(describePhotoGradeExplanation(noBird, null, t).kind).toBe('no_bird')

    const failed = makePhoto({
      id: 'p-fail',
      fileName: 'FAIL.JPG',
      shotAt: '2026-11-22T09:00:04Z',
      analysisStatus: 'failed',
      analysisErrorCode: 'broken_image',
    })
    expect(describePhotoGradeExplanation(failed, null, t).kind).toBe('failed')
  })

  it('binds save feedback to photoId so fast photo switching never leaks stale banners', () => {
    setupModalEnv()
    const photos = [
      makePhoto({ id: 'p1', fileName: 'A.JPG', shotAt: '2026-11-22T09:00:00Z' }),
      makePhoto({ id: 'p2', fileName: 'B.JPG', shotAt: '2026-11-22T09:00:01Z' }),
    ]
    const feedbackForP1: ReviewSaveFeedback = {
      photoId: 'p1',
      requestId: 1,
      status: 'saved',
      grade: 'select',
    }

    function Harness() {
      const [activeId, setActiveId] = useState('p1')
      const photo = photos.find((item) => item.id === activeId)!
      return (
        <ReviewModal
          detail={{ photo, group: null }}
          groupPhotos={photos}
          photos={photos}
          saveFeedback={feedbackForP1}
          onClose={() => {}}
          onSelectPhoto={setActiveId}
          onSetDecision={() => {}}
          onSetSpeciesOverride={() => {}}
          onThumbnailLoadStatus={() => {}}
          t={t}
        />
      )
    }

    renderWithQuery(<Harness />)
    expect(screen.getByText('已保存为精选')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '下一张' }))
    expect(screen.getByRole('heading', { name: 'B.JPG' })).toBeVisible()
    expect(screen.queryByText('已保存为精选')).toBeNull()
  })

  it('supports in-burst A/B compare with pane focus grading, B stepping and Esc return', () => {
    setupModalEnv()
    const photos = [
      makePhoto({
        id: 'p1',
        fileName: 'BURST_1.JPG',
        shotAt: '2026-11-22T09:00:00Z',
        grade: 'usable',
        finalScore: 0.7,
      }),
      makePhoto({
        id: 'p2',
        fileName: 'BURST_2.JPG',
        shotAt: '2026-11-22T09:00:01Z',
        grade: 'select',
        finalScore: 0.88,
      }),
      makePhoto({
        id: 'p3',
        fileName: 'BURST_3.JPG',
        shotAt: '2026-11-22T09:00:02Z',
        grade: 'usable',
        finalScore: 0.74,
      }),
    ]
    const onDecision = vi.fn<(photoId: string, decision: PhotoGrade | null) => void>()
    const onClose = vi.fn()

    const view = renderWithQuery(
      <ReviewModal
        detail={{ photo: photos[0], group: null }}
        groupPhotos={photos}
        photos={photos}
        onClose={onClose}
        onSelectPhoto={() => {}}
        onSetDecision={onDecision}
        onSetSpeciesOverride={() => {}}
        onThumbnailLoadStatus={() => {}}
        t={t}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'A/B 对照' }))
    expect(view.container.querySelector('[data-compare-pane="a"]')).not.toBeNull()
    expect(view.container.querySelector('[data-compare-pane="b"]')).toHaveTextContent('BURST_2.JPG')

    // Default focus is A -> pressing 1 grades p1.
    fireEvent.keyDown(window, { key: '1' })
    expect(onDecision).toHaveBeenLastCalledWith('p1', 'select')

    // Switch focus to B and grade B -> grades p2.
    fireEvent.keyDown(window, { key: 'b' })
    expect(screen.getByText(/当前评级目标：帧 B（BURST_2\.JPG）/)).toBeVisible()
    fireEvent.keyDown(window, { key: '2' })
    expect(onDecision).toHaveBeenLastCalledWith('p2', 'usable')

    // Step B to next frame in burst -> p3.
    fireEvent.click(screen.getByRole('button', { name: '下一张对照帧' }))
    expect(view.container.querySelector('[data-compare-pane="b"]')).toHaveTextContent('BURST_3.JPG')

    // Escape exits A/B compare without closing ReviewModal.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(view.container.querySelector('[data-compare-pane="a"]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'BURST_1.JPG' })).toBeVisible()
  })
})
