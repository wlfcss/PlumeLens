import { afterEach, expect, it, vi } from 'vitest'

import { readSummaryLines } from '../../shared/library-summary-stream'
import { api, type PhotoRow } from '@/lib/api-client'

afterEach(() => vi.unstubAllGlobals())

it('decodes UTF-8 records when the source splits every byte, including multibyte filenames', async () => {
  const text = '{"library":{"id":"羽🐦"}}\n[{"file_name":"白鹭.jpg"}]\n1\n'
  const bytes = [...new TextEncoder().encode(text)]
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  })
  const lines: string[] = []
  await readSummaryLines(stream, (line) => lines.push(line))
  expect(lines).toEqual(text.trimEnd().split('\n'))
})

it('rejects a truncated line and releases the reader', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"library":'))
      controller.close()
    },
  })
  await expect(readSummaryLines(stream, vi.fn())).rejects.toThrow('Incomplete library summary')
  expect(stream.locked).toBe(false)
})

function simulateSummary(...frames: unknown[]) {
  vi.stubGlobal('plumelens', {
    engineRequest: async (_path: string, _init: unknown, receive?: (record: string) => void) => {
      for (const frame of frames) receive?.(JSON.stringify(frame))
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: '',
        contentType: 'application/x-ndjson',
      }
    },
  })
}

const header = {
  library: { id: 'large' },
  projection_revision: 'fixed',
  photo_total: 10,
}

it('returns complete ordered photos with the pinned revision and a separate snapshot count', async () => {
  simulateSummary(header, [{ id: 'a' }], [{ id: 'b' }], 2)
  await expect(api.libraryDetail('large', { view: 'summary' })).resolves.toEqual({
    ...header,
    photos: [{ id: 'a' }, { id: 'b' }],
  })
})

it('shares unchanged rows and nested fields while consuming the next revision', async () => {
  const unchanged = { id: 'a', decision: null } as PhotoRow
  const changed = { id: 'b', decision: null, exif: { ISO: 400 } } as PhotoRow
  const incoming = { ...changed, decision: 'reject', exif: { ISO: 400 } }
  simulateSummary(header, [unchanged], [incoming], 2)

  const next = await api.libraryDetail('large', {
    view: 'summary',
    previousPhotos: [unchanged, changed],
  })
  expect(next.photos).toEqual([unchanged, incoming])
  expect(next.photos[0]).toBe(unchanged)
  expect(next.photos[1]).not.toBe(changed)
  expect(next.photos[1].exif).toBe(changed.exif)
  expect(changed.decision).toBeNull()
})

it.each([
  { frames: [[{ id: 'a' }]] },
  { frames: [[{ id: 'a' }], 2] },
  { frames: [[{ id: 'a' }], 1, []] },
])('discards incomplete or inconsistent streams', ({ frames }) => {
  simulateSummary(header, ...frames)
  return expect(api.libraryDetail('large', { view: 'summary' })).rejects.toThrow(/summary stream/)
})
