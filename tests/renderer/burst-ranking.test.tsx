import React, { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { ReviewModal } from '@/components/review/review-modal'
import { api } from '@/lib/api-client'
import {
  bestPhotoForStack,
  buildPhotoSegments,
  buildReviewSegmentPhotosByPhotoId,
  comparePhotosByScoreDesc,
  rankPhotoInGroup,
  sortPhotos,
} from '@/lib/photo-grid-helpers'
import type { PhotoGrade, PhotoRecord, SelectionDecision } from '@/lib/workspace-types'

const t = i18n.getFixedT('zh-CN')
const clients: QueryClient[] = []
const dialogMethods = ['showModal', 'close'] as const
const originalDialog = dialogMethods.map((key) =>
  Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, key),
)

function makePhoto(
  overrides: Partial<PhotoRecord> & {
    id: string
    fileName: string
    shotAt: string
    grade: PhotoGrade
    finalScore: number | null
  },
): PhotoRecord {
  const { id, fileName, shotAt, grade, finalScore, ...rest } = overrides
  return {
    id,
    folderId: 'folder-1',
    groupId: 'group-1',
    fileName,
    shotAt,
    speciesName: '白鹭',
    speciesLatinName: 'Egretta garzetta',
    speciesEnglishName: 'little egret',
    speciesCandidates: [],
    speciesSource: 'model',
    manualSpecies: false,
    isNewSpecies: false,
    birdCount: 1,
    analysisStatus: 'done',
    grade,
    decision: null,
    finalScore,
    semanticScore: finalScore,
    technicalScore: finalScore,
    poseTags: ['perched'],
    problemTags: [],
    bestBbox: { x1: 100, y1: 100, x2: 300, y2: 300, confidence: 0.95 },
    imageWidth: 1000,
    imageHeight: 800,
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

describe('unified burst ranking and review scope', () => {
  it('prioritizes manual grade upgrades consistently across cover, best, rank and score sort', () => {
    const highAutoUsable = makePhoto({
      id: 'p1',
      fileName: 'IMG_0001.JPG',
      shotAt: '2026-11-22T09:00:00Z',
      grade: 'usable',
      finalScore: 0.78,
    })
    const manuallyPromoted = makePhoto({
      id: 'p2',
      fileName: 'IMG_0002.JPG',
      shotAt: '2026-11-22T09:00:01Z',
      grade: 'record',
      decision: 'select',
      finalScore: 0.62,
    })
    const lowerAutoUsable = makePhoto({
      id: 'p3',
      fileName: 'IMG_0003.JPG',
      shotAt: '2026-11-22T09:00:02Z',
      grade: 'usable',
      finalScore: 0.72,
    })

    const shuffled = [lowerAutoUsable, highAutoUsable, manuallyPromoted]
    const segments = buildPhotoSegments(shuffled)
    expect(segments).toHaveLength(1)
    expect(segments[0].coverPhoto.id).toBe('p2')
    expect(bestPhotoForStack(shuffled)?.id).toBe('p2')
    expect(sortPhotos(shuffled, 'score').map((photo) => photo.id)).toEqual(['p2', 'p1', 'p3'])
    expect(rankPhotoInGroup(segments[0].photos, 'p2')).toBe(1)
    expect(rankPhotoInGroup(segments[0].photos, 'p1')).toBe(2)
    expect(rankPhotoInGroup(segments[0].photos, 'p3')).toBe(3)
  })

  it('breaks exact grade and score ties deterministically regardless of input order', () => {
    const earliest = makePhoto({
      id: 'z-early',
      fileName: 'IMG_0009.JPG',
      shotAt: '2026-11-22T09:00:00Z',
      grade: 'usable',
      finalScore: 0.75,
    })
    const sameSecondEarlierName = makePhoto({
      id: 'b-second',
      fileName: 'IMG_0002.JPG',
      shotAt: '2026-11-22T17:00:01+08:00',
      grade: 'usable',
      finalScore: 0.75,
    })
    const sameSecondLaterNameEarlierId = makePhoto({
      id: 'a-id',
      fileName: 'IMG_0003.JPG',
      shotAt: '2026-11-22T09:00:01Z',
      grade: 'usable',
      finalScore: 0.75,
    })
    const sameSecondSameNameLaterId = makePhoto({
      id: 'b-id',
      fileName: 'IMG_0003.JPG',
      shotAt: '2026-11-22T09:00:01Z',
      grade: 'usable',
      finalScore: 0.75,
    })
    const missingTime = makePhoto({
      id: 'no-time',
      fileName: 'IMG_0000.JPG',
      shotAt: 'invalid-date',
      grade: 'usable',
      finalScore: 0.75,
    })

    const expectedOrder = [
      earliest.id,
      sameSecondEarlierName.id,
      sameSecondLaterNameEarlierId.id,
      sameSecondSameNameLaterId.id,
      missingTime.id,
    ]
    const permutations = [
      [
        missingTime,
        sameSecondSameNameLaterId,
        earliest,
        sameSecondLaterNameEarlierId,
        sameSecondEarlierName,
      ],
      [
        sameSecondEarlierName,
        sameSecondSameNameLaterId,
        missingTime,
        earliest,
        sameSecondLaterNameEarlierId,
      ],
    ]

    for (const input of permutations) {
      const sorted = input.toSorted(comparePhotosByScoreDesc)
      expect(sorted.map((photo) => photo.id)).toEqual(expectedOrder)
      expect(bestPhotoForStack(input)?.id).toBe(earliest.id)
      const segments = buildPhotoSegments(input)
      expect(segments).toHaveLength(1)
      expect(segments[0].coverPhoto.id).toBe(earliest.id)
      expectedOrder.forEach((id, idx) => {
        expect(rankPhotoInGroup(segments[0].photos, id)).toBe(idx + 1)
      })
    }
  })

  it('recomputes burst cover, best and rank identically when filtering changes members', () => {
    const topSelect = makePhoto({
      id: 'p1',
      fileName: 'BURST_0001.JPG',
      shotAt: '2026-11-22T09:00:00Z',
      grade: 'select',
      finalScore: 0.9,
    })
    const tiedEarly = makePhoto({
      id: 'p2',
      fileName: 'BURST_0002.JPG',
      shotAt: '2026-11-22T09:00:01Z',
      grade: 'usable',
      finalScore: 0.75,
    })
    const tiedLate = makePhoto({
      id: 'p3',
      fileName: 'BURST_0003.JPG',
      shotAt: '2026-11-22T09:00:02Z',
      grade: 'usable',
      finalScore: 0.75,
    })

    const fullSegments = buildPhotoSegments([topSelect, tiedEarly, tiedLate])
    expect(fullSegments[0].coverPhoto.id).toBe('p1')

    const filtered = [tiedLate, tiedEarly]
    const filteredSegments = buildPhotoSegments(filtered)
    const reviewMap = buildReviewSegmentPhotosByPhotoId(filtered)
    expect(filteredSegments).toHaveLength(1)
    expect(filteredSegments[0].photos.map((photo) => photo.id)).toEqual(['p2', 'p3'])
    expect(filteredSegments[0].coverPhoto.id).toBe('p2')
    expect(reviewMap.get('p2')?.map((photo) => photo.id)).toEqual(['p2', 'p3'])
    expect(bestPhotoForStack(reviewMap.get('p2') ?? [])?.id).toBe('p2')
    expect(rankPhotoInGroup(reviewMap.get('p2') ?? [], 'p2')).toBe(1)
    expect(rankPhotoInGroup(reviewMap.get('p2') ?? [], 'p3')).toBe(2)
  })

  it('renders a single consistent best badge and rank in ReviewModal after manual upgrade and on ties', () => {
    setupModalEnv()
    const initialPhotos = [
      makePhoto({
        id: 'p1',
        fileName: 'BURST_0001.JPG',
        shotAt: '2026-11-22T09:00:00Z',
        grade: 'usable',
        finalScore: 0.78,
      }),
      makePhoto({
        id: 'p2',
        fileName: 'BURST_0002.JPG',
        shotAt: '2026-11-22T09:00:01Z',
        grade: 'record',
        finalScore: 0.62,
      }),
      makePhoto({
        id: 'p3',
        fileName: 'BURST_0003.JPG',
        shotAt: '2026-11-22T09:00:02Z',
        grade: 'usable',
        finalScore: 0.78,
      }),
    ]

    function Harness() {
      const [photos, setPhotos] = useState(initialPhotos)
      const [activeId, setActiveId] = useState('p2')
      const active = photos.find((item) => item.id === activeId)!
      const segmentPhotos = buildReviewSegmentPhotosByPhotoId(photos).get(active.id) ?? []

      function handleDecision(photoId: string, decision: SelectionDecision) {
        setPhotos((current) =>
          current.map((item) => (item.id === photoId ? { ...item, decision } : item)),
        )
      }

      return (
        <ReviewModal
          detail={{ photo: active, group: null }}
          groupPhotos={segmentPhotos}
          photos={photos}
          onClose={() => {}}
          onSelectPhoto={setActiveId}
          onSetDecision={handleDecision}
          onSetSpeciesOverride={() => {}}
          onThumbnailLoadStatus={() => {}}
          t={t}
        />
      )
    }

    const view = renderWithQuery(<Harness />)
    // Initially p1 and p3 tie at usable 78.0; p1 (earlier) is #1 and best, p2 is #3.
    expect(screen.getByText('排名 #3')).toBeVisible()
    expect(screen.queryByText('本组最佳')).toBeNull()
    expect(screen.getByText('本组 3 张 · 排名 #3 · 最佳 78.0')).toBeVisible()

    // Check p1 vs p3 tie in ReviewModal: p1 is #1 + best, p3 is #2 without best.
    fireEvent.click(screen.getByRole('button', { name: '上一张' }))
    expect(screen.getByRole('heading', { name: 'BURST_0001.JPG' })).toBeVisible()
    expect(screen.getByText('排名 #1')).toBeVisible()
    expect(screen.getByText('本组最佳')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '下一张' }))
    fireEvent.click(screen.getByRole('button', { name: '下一张' }))
    expect(screen.getByRole('heading', { name: 'BURST_0003.JPG' })).toBeVisible()
    expect(screen.getByText('排名 #2')).toBeVisible()
    expect(screen.queryByText('本组最佳')).toBeNull()

    // Navigate back to p2 and manually upgrade p2 (62.0) to select.
    fireEvent.click(screen.getByRole('button', { name: '上一张' }))
    expect(screen.getByRole('heading', { name: 'BURST_0002.JPG' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '精选' }))

    expect(screen.getByText('排名 #1')).toBeVisible()
    expect(screen.getByText('本组最佳')).toBeVisible()
    expect(screen.getByText('本组 3 张 · 排名 #1 · 最佳 62.0')).toBeVisible()
    expect(view.container.querySelectorAll('.review-sequence__rail i.is-best')).toHaveLength(1)

    // Move to p1: it must no longer claim best and drops to #2.
    fireEvent.click(screen.getByRole('button', { name: '上一张' }))
    expect(screen.getByRole('heading', { name: 'BURST_0001.JPG' })).toBeVisible()
    expect(screen.getByText('排名 #2')).toBeVisible()
    expect(screen.queryByText('本组最佳')).toBeNull()
    expect(screen.getByText('本组 3 张 · 排名 #2 · 最佳 62.0')).toBeVisible()
  })

  it('shows filtered scope and hides stale burst ranking when a photo leaves the active filter', () => {
    setupModalEnv()
    const filteredBurst = [
      makePhoto({
        id: 'p2',
        fileName: 'FILTER_0002.JPG',
        shotAt: '2026-11-22T09:00:01Z',
        grade: 'usable',
        finalScore: 0.75,
      }),
      makePhoto({
        id: 'p3',
        fileName: 'FILTER_0003.JPG',
        shotAt: '2026-11-22T09:00:02Z',
        grade: 'usable',
        finalScore: 0.75,
      }),
    ]

    const view = renderWithQuery(
      <ReviewModal
        detail={{ photo: filteredBurst[0], group: null }}
        groupPhotos={filteredBurst}
        photos={filteredBurst}
        sequenceTotalCount={4}
        onClose={() => {}}
        onSelectPhoto={() => {}}
        onSetDecision={() => {}}
        onSetSpeciesOverride={() => {}}
        onThumbnailLoadStatus={() => {}}
        t={t}
      />,
    )
    expect(screen.getByText('当前筛选连拍')).toBeVisible()
    expect(screen.getByText('排名 #1')).toBeVisible()
    expect(screen.getByText('本组最佳')).toBeVisible()
    expect(screen.getByText('当前筛选 2/4 张 · 排名 #1 · 最佳 75.0')).toBeVisible()

    view.rerender(
      <QueryClientProvider client={clients[clients.length - 1]}>
        <ReviewModal
          detail={{ photo: filteredBurst[0], group: null }}
          groupPhotos={filteredBurst}
          photos={filteredBurst}
          outsideSelection
          sequenceTotalCount={4}
          onClose={() => {}}
          onSelectPhoto={() => {}}
          onSetDecision={() => {}}
          onSetSpeciesOverride={() => {}}
          onThumbnailLoadStatus={() => {}}
          t={t}
        />
      </QueryClientProvider>,
    )
    expect(screen.getAllByText('已移出当前筛选')).toHaveLength(2)
    expect(screen.queryByText('本组最佳')).toBeNull()
    expect(screen.queryByText(/排名 #/)).toBeNull()
  })
})
