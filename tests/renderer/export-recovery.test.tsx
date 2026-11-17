import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useTranslation } from 'react-i18next'
import '@/i18n'
import type { EngineSseBridgeEvent } from '@/env'
import { ExportDrawer, type ExportSourceSnapshot } from '@/components/export-drawer'
import { api, type ExportJobSnapshot } from '@/lib/api-client'
import { createInitialWorkspace } from '@/lib/workspace-fixtures'
import { buildFolderSummary } from '@/lib/workspace-projection'

const originalBridge = Object.getOwnPropertyDescriptor(window, 'plumelens')
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (originalBridge) Object.defineProperty(window, 'plumelens', originalBridge)
  else Reflect.deleteProperty(window, 'plumelens')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function failed(jobId: string, libraryId: string): ExportJobSnapshot {
  return {
    job_id: jobId,
    library_id: libraryId,
    status: 'failed',
    total: 1,
    processed: 1,
    exported: 0,
    companions: 0,
    xmp: 0,
    missing: 0,
    failed: 1,
    total_bytes: 100,
    copied_bytes: 0,
    current_file: null,
    output_dir: null,
    result: null,
    error: { code: 'internal_error' },
  }
}

it('ignores a previous export recovery snapshot that arrives after a new job starts', async () => {
  const workspace = createInitialWorkspace()
  const folder = workspace.folders[0]
  const photos = workspace.photos.filter((photo) => photo.folderId === folder.id)
  const source: ExportSourceSnapshot = { folder, photos, summary: buildFolderSummary(photos) }
  const callbacks = new Map<string, (event: EngineSseBridgeEvent) => void>()
  const unsubscribes = new Map<string, ReturnType<typeof vi.fn>>()
  Object.defineProperty(window, 'plumelens', {
    configurable: true,
    value: {
      selectExportDirectory: async () => '/tmp/plumelens-export-test',
      engineSseSubscribe: (path: string, callback: (event: EngineSseBridgeEvent) => void) => {
        callbacks.set(path, callback)
        const unsubscribe = vi.fn()
        unsubscribes.set(path, unsubscribe)
        return unsubscribe
      },
    },
  })
  vi.spyOn(api, 'exportFormats').mockResolvedValue({
    formats: [{ ext: 'ORF', count: photos.length, bytes: 100, is_raw: true }],
  })
  const start = vi
    .spyOn(api, 'exportLibrary')
    .mockResolvedValueOnce({ job_id: 'A', library_id: folder.id, total: 1, total_bytes: 100 })
    .mockResolvedValueOnce({ job_id: 'B', library_id: folder.id, total: 1, total_bytes: 100 })
  const lateRecovery = deferred<ExportJobSnapshot>()
  // A's immediate SSE error recovery waits. The subsequent polling recovery
  // observes A's failure first, allowing the user to start B legitimately.
  vi.spyOn(api, 'exportJobSnapshot')
    .mockImplementationOnce(() => lateRecovery.promise)
    .mockResolvedValue(failed('A', folder.id))
  function Panel() {
    const { t } = useTranslation()
    return <ExportDrawer source={source} onClose={() => undefined} t={t} />
  }
  render(<Panel />)
  fireEvent.click(screen.getByRole('button', { name: '选择位置' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '开始导出' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '开始导出' }))
  await waitFor(() => expect(callbacks.has('/export/jobs/A/events')).toBe(true))
  act(() => callbacks.get('/export/jobs/A/events')!({ type: 'error', message: 'connection lost' }))
  fireEvent.click(await screen.findByRole('button', { name: '新建导出' }))
  fireEvent.click(screen.getByRole('button', { name: '开始导出' }))
  await waitFor(() => expect(callbacks.has('/export/jobs/B/events')).toBe(true))
  expect(start).toHaveBeenCalledTimes(2)
  await act(async () => lateRecovery.resolve(failed('A', folder.id)))
  expect(unsubscribes.get('/export/jobs/B/events')).not.toHaveBeenCalled()
  expect(screen.getByText('正在导出')).toBeVisible()
})
