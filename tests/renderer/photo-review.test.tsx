import React, { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import i18n from '@/i18n'
import { afterEach, expect, it, vi } from 'vitest'

import { ReviewModal } from '@/components/review/review-modal'
import { PHOTO_REVIEW_KEY, usePhotoReview } from '@/hooks/use-photo-review'
import {
  api,
  ApiError,
  type BirdDetectionDetail,
  type PhotoReviewResponse,
  type PhotoRow,
} from '@/lib/api-client'
import { buildPhotoRecordFromRow } from '@/lib/backend-adapter'
import { getArchiveSpeciesEntries } from '@/lib/photo-display'
import { speciesSourceBadge } from '@/lib/species-source'
import { extractPhotoGps } from '@/lib/workspace-projection'

const libraryId = 'review-test-library'
const groupId = 'review-test-scene'
const t = i18n.getFixedT('en')
const clients: QueryClient[] = []
const dialogMethods = ['showModal', 'close'] as const
const originalDialog = dialogMethods.map((key) =>
  Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, key),
)

function detection(index: number, full: boolean): BirdDetectionDetail {
  const species = index === 0 ? ['喜鹊', 'Pica serica'] : ['白鹭', 'Egretta garzetta']
  const confirmed = { canonical_zh: species[0], canonical_sci: species[1], confidence: 0.9 }
  const alternate = { canonical_zh: '鸳鸯', canonical_sci: 'Aix galericulata', confidence: 0.1 }
  return {
    index,
    is_best: index === 0,
    bbox: { x1: 250 + index * 30, y1: 180, x2: 550 + index * 30, y2: 420, confidence: 0.95 },
    pose: {
      head_visible: true,
      eye_visible: true,
      posture: index === 0 ? 'perched' : 'flying',
      ...(full && { bill: { x: 330 + index * 50, y: 285, confidence: 0.9 } }),
    },
    quality: { clipiqa: 0.8, hyperiqa: 0.9, combined: 0.86 },
    species: species[0],
    species_latin: species[1],
    species_source: 'model',
    manual_species: false,
    ...(full
      ? { species_candidates: [confirmed, alternate] }
      : { candidate_confidence: 0.9, candidate_recognition_state: 'recognized' }),
  }
}

function row(id: string, full: boolean, revision = 1, review = `${id}-${revision}`): PhotoRow {
  return {
    id,
    input_revision: revision,
    review_revision: review,
    file_name: `${id}.jpg`,
    file_path: `/tmp/review/${id}.jpg`,
    format: 'jpg',
    width: 800,
    height: 600,
    thumb_grid: `grid/${id}.jpg`,
    thumb_preview: `preview/${id}.jpg`,
    created_at: '2026-11-17T10:00:00Z',
    shot_at: '2026-11-17T10:00:00Z',
    scene_id: 1,
    pipeline_version: 'analysis-1',
    grade: 'select',
    decision: null,
    quality_score: 0.86,
    bird_count: 2,
    species: '喜鹊',
    species_latin: 'Pica serica',
    species_source: 'model',
    manual_species: false,
    exif: {
      ExposureTime: 0.001,
      GPSInfo: { GPSLatitude: [30, 0, 0], GPSLongitude: [120, 0, 0] },
      ...(full && { Model: `Camera ${id}`, af_point: { x: 400, y: 300 } }),
    },
    best_detection: detection(0, full),
    detections: [detection(0, full), detection(1, full)],
  }
}

function summary(id: string, revision?: number, review?: string) {
  return buildPhotoRecordFromRow(row(id, false, revision, review), libraryId, groupId, t)
}

function deferred<T>() {
  return Promise.withResolvers<T>()
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const Wrapper = ({ children }: React.PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, Wrapper }
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

it('keeps the original navigation usable while hydrating only the visibly selected photo', async () => {
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
  const first = deferred<PhotoReviewResponse>()
  const second = deferred<PhotoReviewResponse>()
  const requests = vi
    .spyOn(api, 'photoReview')
    .mockImplementation((id) => (id === 'first' ? first : second).promise)
  const { Wrapper } = wrapper()
  const photos = [summary('first'), summary('second')]
  const edit = vi.fn()
  function Harness() {
    const [photo, setPhoto] = useState(photos[0])
    return (
      <ReviewModal
        detail={{ photo, group: null }}
        photos={photos}
        groupPhotos={photos}
        onClose={() => {}}
        onSelectPhoto={(id) => setPhoto(photos.find((item) => item.id === id)!)}
        onSetDecision={() => {}}
        onSetSpeciesOverride={edit}
        onThumbnailLoadStatus={() => {}}
        t={t}
      />
    )
  }
  const view = render(<Harness />, { wrapper: Wrapper })
  expect(await screen.findByText(t('selection.review.loadingDetails'))).toBeVisible()
  expect(screen.getByRole('heading', { name: 'first.jpg' })).toBeVisible()
  expect(view.container.querySelector('.species-editor')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: t('selection.review.next') }))
  expect(screen.getByRole('heading', { name: 'second.jpg' })).toBeVisible()
  await waitFor(() => expect(requests).toHaveBeenCalledTimes(2))
  expect(requests.mock.calls[0][1]?.aborted).toBe(true)
  await act(async () => first.resolve({ library_id: libraryId, photo: row('first', true) }))
  expect(screen.queryByText('Camera first')).toBeNull()
  expect(screen.getByText(t('selection.review.loadingDetails'))).toBeVisible()

  await act(async () => second.resolve({ library_id: libraryId, photo: row('second', true) }))
  expect(await screen.findByText('Camera second')).toBeVisible()
  expect(view.container.querySelectorAll('.species-editor__bird')).toHaveLength(2)
  const poseToggle = screen.getByRole('checkbox', { name: t('selection.review.togglePose') })
  fireEvent.click(poseToggle)
  expect(view.container.querySelector('.pose-point')).not.toBeNull()
  expect(photos[1].bestPose?.bill).toBeUndefined()
  expect(photos[1].bestAfPoint).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: `${t('selection.speciesEditor.bird')} 2` }))
  fireEvent.click(view.container.querySelector('.species-editor__current--toggle')!)
  fireEvent.click(screen.getByRole('button', { name: /Aix galericulata/ }))
  expect(edit).toHaveBeenCalledWith(
    'second',
    1,
    expect.objectContaining({ canonical_sci: 'Aix galericulata' }),
    { x1: 280, y1: 180, x2: 580, y2: 420 },
  )
})

it('allows retry after a failed request and replaces the same id when input revision advances', async () => {
  const secondInput = deferred<PhotoReviewResponse>()
  const fetch = vi
    .spyOn(api, 'photoReview')
    .mockRejectedValueOnce(new ApiError(503, 'temporary'))
    .mockResolvedValueOnce({ library_id: libraryId, photo: row('first', true) })
    .mockReturnValueOnce(secondInput.promise)
  const { Wrapper, client } = wrapper()
  const view = renderHook(({ source }) => usePhotoReview(source, t), {
    wrapper: Wrapper,
    initialProps: { source: summary('first') },
  })

  await waitFor(() => expect(view.result.current.error).toBe(true))
  act(() => view.result.current.onRetry())
  await waitFor(() => expect(view.result.current.photo?.bestPose?.bill?.x).toBe(330))
  expect(view.result.current.photo?.birdDetections?.[1].speciesCandidates).toHaveLength(2)

  view.rerender({ source: summary('first', 2) })
  expect(view.result.current.loading).toBe(true)
  expect(view.result.current.photo).toBeUndefined()
  await act(async () =>
    secondInput.resolve({ library_id: libraryId, photo: row('first', true, 2) }),
  )
  await waitFor(() => expect(view.result.current.photo?.inputRevision).toBe(2))
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(client.getQueriesData({ queryKey: PHOTO_REVIEW_KEY('first') })).toHaveLength(1)
})

it.each([
  ['other library', { library_id: 'unrelated', photo: row('first', true) }],
  ['other photo', { library_id: libraryId, photo: row('second', true) }],
  ['other input', { library_id: libraryId, photo: row('first', true, 2) }],
  ['updated analysis', { library_id: libraryId, photo: row('first', true, 1, 'different') }],
] as const)('does not cache review data belonging to %s', async (_case, response) => {
  vi.spyOn(api, 'photoReview').mockResolvedValue(response)
  const { Wrapper, client } = wrapper()
  const view = renderHook(() => usePhotoReview(summary('first'), t), { wrapper: Wrapper })
  await waitFor(() => expect(view.result.current.revisionChanged).toBe(true))
  expect(view.result.current.photo).toBeUndefined()
  expect(client.getQueriesData({ queryKey: PHOTO_REVIEW_KEY('first') })[0][1]).toBeUndefined()
})

it('retains compact multi-bird, inspector and map information in summary rows', () => {
  const photo = summary('first')
  expect(getArchiveSpeciesEntries(photo).map((item) => item.latinName)).toEqual([
    'Pica serica',
    'Egretta garzetta',
  ])
  expect(photo.poseTags).toContain('perched')
  expect(photo.exif?.ExposureTime).toBe(0.001)
  expect(extractPhotoGps(photo.exif)).toEqual({ lat: 30, lon: 120 })
  expect(photo.speciesCandidates).toEqual([])
  expect(photo.birdDetections?.[0].speciesCandidates).toEqual([])
  expect(photo.candidateConfidence).toBe(0.9)
  expect(photo.birdDetections?.[0].candidateRecognitionState).toBe('recognized')
  expect(photo.bestPose?.bill).toBeUndefined()

  const unconfirmed: PhotoRow = {
    ...row('first', false),
    species_source: 'model_unconfirmed',
    best_detection: {
      ...detection(0, false),
      species_source: 'model_unconfirmed',
      candidate_recognition_state: 'uncertain',
    },
    detections: null,
  }
  const adapted = buildPhotoRecordFromRow(unconfirmed, libraryId, groupId, t)
  expect(speciesSourceBadge(adapted, t, adapted.birdDetections?.[0])).toBe(
    t('selection.speciesSource.unconfirmedSpecies'),
  )
})
