import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { ExportDrawer, type ExportSourceSnapshot } from '@/components/export-drawer'
import { api } from '@/lib/api-client'
import { loadCustomExportPresets } from '@/lib/export-presets'

const t = i18n.getFixedT('zh-CN')

const source: ExportSourceSnapshot = {
  folder: {
    id: 'lib-presets',
    displayName: '外拍测试',
    parentPath: '/tmp',
    rootPath: '/tmp/lib-presets',
    status: 'ready',
    totalCount: 2,
    analyzedCount: 2,
    recursive: true,
    lastOpenedAt: '2026-11-22T09:00:00Z',
    lastScannedAt: null,
    lastAnalyzedAt: null,
  },
  photos: [
    {
      id: 'p1',
      folderId: 'lib-presets',
      groupId: 'g1',
      fileName: 'IMG_0001.JPG',
      shotAt: '2026-11-22T09:00:00Z',
      speciesName: '白鹭',
      speciesLatinName: 'Egretta garzetta',
      speciesCandidates: [],
      birdCount: 1,
      analysisStatus: 'done',
      grade: 'select',
      decision: null,
      finalScore: 0.88,
      semanticScore: 0.88,
      technicalScore: 0.88,
      poseTags: [],
      problemTags: [],
      boxes: [],
      caption: '',
      previewGradient: '',
    } as ExportSourceSnapshot['photos'][number],
    {
      id: 'p2',
      folderId: 'lib-presets',
      groupId: 'g1',
      fileName: 'IMG_0002.JPG',
      shotAt: '2026-11-22T09:00:01Z',
      speciesName: '白鹭',
      speciesLatinName: 'Egretta garzetta',
      speciesCandidates: [],
      birdCount: 1,
      analysisStatus: 'done',
      grade: 'usable',
      decision: null,
      finalScore: 0.68,
      semanticScore: 0.68,
      technicalScore: 0.68,
      poseTags: [],
      problemTags: [],
      boxes: [],
      caption: '',
      previewGradient: '',
    } as ExportSourceSnapshot['photos'][number],
  ],
  summary: {
    newSpeciesCount: 0,
    birdPhotoCount: 2,
    noBirdCount: 0,
    failedCount: 0,
    speciesCount: 1,
    gradeCounts: { select: 1, usable: 1, record: 0, reject: 0 },
  },
}

beforeEach(() => {
  window.localStorage.clear()
  vi.spyOn(api, 'exportFormats').mockResolvedValue({
    formats: [{ ext: 'JPG', count: 2, bytes: 1000, is_raw: false }],
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('ExportDrawer Lightroom presets', () => {
  it('applies built-in Lightroom presets and saves/deletes custom named presets', async () => {
    render(<ExportDrawer onClose={() => {}} source={source} t={t} />)

    const lrSelects = screen.getByRole('button', { name: 'Lightroom 精选分档' })
    fireEvent.click(lrSelects)
    expect(lrSelects).toHaveAttribute('aria-pressed', 'true')

    const xmpOnly = screen.getByRole('button', { name: '仅 XMP 边车' })
    fireEvent.click(xmpOnly)
    expect(xmpOnly).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: '保存为预设' }))
    const input = screen.getByPlaceholderText('输入预设名称')
    fireEvent.change(input, { target: { value: '我的 Lightroom 精选' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(screen.getByRole('button', { name: '我的 Lightroom 精选' })).toBeVisible()
    expect(loadCustomExportPresets().map((item) => item.name)).toEqual(['我的 Lightroom 精选'])

    fireEvent.click(screen.getByRole('button', { name: '删除预设 我的 Lightroom 精选' }))
    expect(screen.queryByRole('button', { name: '我的 Lightroom 精选' })).toBeNull()
    expect(loadCustomExportPresets()).toEqual([])
  })
})
