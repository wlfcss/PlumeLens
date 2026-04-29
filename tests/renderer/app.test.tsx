import React from 'react'
import { act, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import '@/i18n'
import App, {
  buildArchiveMapPins,
  buildSpeciesCollectionGroups,
  deriveSpeciesRecords,
  extractPhotoGps,
  getArchiveSpeciesEntries,
  isPlainSpaceKey,
  shouldIgnoreSelectionReviewShortcutTarget,
} from '@/App'
import { listAllSpecies, resolveSpeciesCanonicalSci } from '@/lib/species-wiki'
import type { FolderRecord, PhotoRecord, WorkspaceSnapshot } from '@/lib/mock-workspace'

// Mock the Electron preload API
beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const path = new URL(url).pathname
      if (path === '/health') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.2.0',
            pipeline: {
              ready: false,
              version: 'test',
              quality_available: false,
              pose_available: false,
              species_available: false,
              models: {},
            },
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        )
      }
      if (path === '/library') {
        return new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        })
      }
      if (path.startsWith('/library/')) {
        return new Response(
          JSON.stringify({
            library: {
              id: path.split('/').pop() ?? 'test',
              display_name: '测试库',
              parent_path: '/tmp',
              root_path: '/tmp/test',
              status: 'ready',
              total_count: 0,
              analyzed_count: 0,
              recursive: true,
              last_opened_at: '2026-04-27T00:00:00Z',
              last_scanned_at: null,
              last_analyzed_at: null,
            },
            photos: [],
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        )
      }
      return new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    }),
  )
  window.plumelens = {
    getBackendUrl: async () => 'http://127.0.0.1:8000',
    getBackendAuthToken: async () => null,
    getAppVersion: async () => '0.1.0',
    openFolder: async () => null,
    onBackendReady: () => {},
    onBackendError: () => {},
  }
  // jsdom 不实现 EventSource；useAnalysisProgress 订阅 SSE 时会 ReferenceError
  if (typeof (globalThis as Record<string, unknown>).EventSource === 'undefined') {
    class StubEventSource {
      onmessage: ((ev: MessageEvent) => void) | null = null
      onerror: ((ev: Event) => void) | null = null
      addEventListener(): void {
        // no-op
      }
      close(): void {
        // no-op
      }
    }
    ;(globalThis as Record<string, unknown>).EventSource = StubEventSource
  }
})

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('App', () => {
  it('renders the app title', async () => {
    const view = renderWithProviders(<App />)
    expect(screen.getAllByText('鉴翎').length).toBeGreaterThan(0)
    view.unmount()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  })

  it('keeps model extras in catalog while marking v12 membership', () => {
    const allSpecies = listAllSpecies()
    const modelExtras = allSpecies.filter((species) => species.in_china_v12 === false)

    expect(allSpecies).toHaveLength(1535)
    expect(modelExtras).toHaveLength(19)
    expect(modelExtras.every((species) => species.is_trained)).toBe(true)
    expect(modelExtras.map((species) => species.canonical_sci)).toContain('Pygoscelis papua')
  })

  it('resolves only safe canonical aliases', () => {
    expect(resolveSpeciesCanonicalSci('暗绿绣眼鸟')).toBe('Zosterops simplex')
    expect(resolveSpeciesCanonicalSci('Zosterops simplex')).toBe('Zosterops simplex')
    expect(resolveSpeciesCanonicalSci('星鴉')).toBeNull()
  })

  it('does not light up top-k candidate species as collected cards', () => {
    const photo = {
      id: 'photo-1',
      folderId: 'folder-1',
      groupId: 'group-1',
      fileName: '5Y3A0001.JPG',
      shotAt: '2026-03-21T15:59:00Z',
      speciesName: '暗绿绣眼鸟',
      speciesLatinName: 'Zosterops simplex',
      speciesEnglishName: "swinhoe's white eye",
      speciesCandidates: [
        {
          name: '日本绣眼鸟',
          latinName: 'Zosterops japonicus',
          englishName: 'japanese white eye',
          confidence: 0.08,
        },
        {
          name: '黄眉柳莺',
          latinName: 'Phylloscopus inornatus',
          englishName: 'yellow browed warbler',
          confidence: 0.05,
        },
      ],
      birdCount: 1,
      analysisStatus: 'done',
      grade: 'select',
      decision: null,
      finalScore: 0.78,
    } as PhotoRecord
    const workspace = {
      folders: [],
      groups: [],
      photos: [photo],
      species: [],
    } as WorkspaceSnapshot

    const records = deriveSpeciesRecords(workspace)
    expect(records.find((species) => species.latinName === 'Zosterops simplex')?.collected).toBe(
      true,
    )
    expect(records.find((species) => species.latinName === 'Zosterops simplex')?.photoCount).toBe(1)
    expect(records.find((species) => species.latinName === 'Zosterops japonicus')?.collected).toBe(
      false,
    )
    expect(
      records.find((species) => species.latinName === 'Phylloscopus inornatus')?.collected,
    ).toBe(false)
  })

  it('only counts archive-eligible photos and lets manual species override model species', () => {
    const manualPhoto = {
      id: 'photo-manual',
      folderId: 'folder-1',
      groupId: 'group-1',
      fileName: '5Y3A0002.JPG',
      shotAt: '2026-03-21T15:59:00Z',
      speciesName: '日本绣眼鸟',
      speciesLatinName: 'Zosterops japonicus',
      speciesEnglishName: 'japanese white eye',
      birdDetections: [
        {
          index: 0,
          bbox: { x1: 0, y1: 0, x2: 100, y2: 100, confidence: 0.9 },
          speciesName: '暗绿绣眼鸟',
          speciesLatinName: 'Zosterops simplex',
          speciesEnglishName: "swinhoe's white eye",
          speciesCandidates: [],
          manualSpecies: true,
          isBest: true,
        },
      ],
      birdCount: 1,
      analysisStatus: 'done',
      grade: 'select',
      decision: null,
      finalScore: 0.78,
    } as PhotoRecord
    const rejectedPhoto = {
      id: 'photo-reject',
      folderId: 'folder-1',
      groupId: 'group-1',
      fileName: '5Y3A0003.JPG',
      shotAt: '2026-03-21T16:00:00Z',
      speciesName: '黄眉柳莺',
      speciesLatinName: 'Phylloscopus inornatus',
      birdCount: 1,
      analysisStatus: 'done',
      grade: 'reject',
      decision: null,
      finalScore: 0.2,
    } as PhotoRecord
    const workspace = {
      folders: [],
      groups: [],
      photos: [manualPhoto, rejectedPhoto],
      species: [],
    } as WorkspaceSnapshot

    const entries = getArchiveSpeciesEntries(manualPhoto)
    const records = deriveSpeciesRecords(workspace)

    expect(entries.map((entry) => entry.latinName)).toEqual(['Zosterops simplex'])
    expect(records.find((species) => species.latinName === 'Zosterops simplex')?.collected).toBe(
      true,
    )
    expect(records.find((species) => species.latinName === 'Zosterops japonicus')?.collected).toBe(
      false,
    )
    expect(records.find((species) => species.latinName === 'Phylloscopus inornatus')?.collected).toBe(
      false,
    )
  })

  it('counts a photo once when multiple detections share the same manual species', () => {
    // 不变量：单图多检测同物种（如群鹭中两只都被人工标注为白鹭），
    // 羽迹该物种照片数应为 1，而非随检测数翻倍。
    const photo = {
      id: 'photo-multi-detection',
      folderId: 'folder-1',
      groupId: 'group-1',
      fileName: '5Y3A0009.JPG',
      shotAt: '2026-03-21T15:59:00Z',
      speciesName: '白鹭',
      speciesLatinName: 'Egretta garzetta',
      birdDetections: [
        {
          index: 0,
          bbox: { x1: 0, y1: 0, x2: 100, y2: 100, confidence: 0.9 },
          speciesName: '白鹭',
          speciesLatinName: 'Egretta garzetta',
          speciesCandidates: [],
          manualSpecies: true,
          isBest: true,
        },
        {
          index: 1,
          bbox: { x1: 200, y1: 0, x2: 300, y2: 100, confidence: 0.85 },
          speciesName: '白鹭',
          speciesLatinName: 'Egretta garzetta',
          speciesCandidates: [],
          manualSpecies: true,
          isBest: false,
        },
      ],
      birdCount: 2,
      analysisStatus: 'done',
      grade: 'select',
      decision: null,
      finalScore: 0.78,
    } as PhotoRecord
    const workspace = {
      folders: [],
      groups: [],
      photos: [photo],
      species: [],
    } as WorkspaceSnapshot

    const entries = getArchiveSpeciesEntries(photo)
    const records = deriveSpeciesRecords(workspace)
    const egretta = records.find((species) => species.latinName === 'Egretta garzetta')

    expect(entries.map((entry) => entry.latinName)).toEqual(['Egretta garzetta'])
    expect(egretta?.collected).toBe(true)
    expect(egretta?.photoCount).toBe(1)
  })

  it('uses recognition correction before raw model species in archive records', () => {
    const consensusPhoto = {
      id: 'photo-consensus',
      folderId: 'folder-1',
      groupId: 'group-1',
      fileName: '5Y3A7450.JPG',
      shotAt: '2026-03-21T15:59:00Z',
      speciesName: '日本绣眼鸟',
      speciesLatinName: 'Zosterops japonicus',
      speciesEnglishName: 'japanese white eye',
      speciesSource: 'group_consensus',
      modelSpeciesName: '日本绣眼鸟',
      modelSpeciesLatinName: 'Zosterops japonicus',
      groupSpeciesName: '暗绿绣眼鸟',
      groupSpeciesLatinName: 'Zosterops simplex',
      groupSpeciesSupport: 7,
      groupSpeciesEvidence: 8,
      birdCount: 1,
      analysisStatus: 'done',
      grade: 'select',
      decision: null,
      finalScore: 0.784,
    } as PhotoRecord
    const workspace = {
      folders: [],
      groups: [],
      photos: [consensusPhoto],
      species: [],
    } as WorkspaceSnapshot

    const entries = getArchiveSpeciesEntries(consensusPhoto)
    const records = deriveSpeciesRecords(workspace)

    expect(entries.map((entry) => entry.latinName)).toEqual(['Zosterops simplex'])
    expect(records.find((species) => species.latinName === 'Zosterops simplex')?.collected).toBe(
      true,
    )
    expect(records.find((species) => species.latinName === 'Zosterops japonicus')?.collected).toBe(
      false,
    )
  })

  it('parses EXIF GPS and hides photos without GPS from the map', () => {
    const gps = extractPhotoGps({
      GPSInfo: {
        GPSLatitudeRef: 'N',
        GPSLatitude: [31, 13, 12],
        GPSLongitudeRef: 'E',
        GPSLongitude: [121, 28, 48],
      },
    })
    const gpsPhoto = {
      id: 'photo-gps',
      folderId: 'folder-1',
      groupId: 'group-1',
      fileName: 'gps.JPG',
      shotAt: '2026-03-21T15:59:00Z',
      speciesName: '暗绿绣眼鸟',
      speciesLatinName: 'Zosterops simplex',
      birdCount: 1,
      analysisStatus: 'done',
      grade: 'usable',
      decision: null,
      finalScore: 0.7,
      exif: { GPSInfo: { 1: 'N', 2: [31, 13, 12], 3: 'E', 4: [121, 28, 48] } },
    } as PhotoRecord
    const unlocatedPhoto = {
      ...gpsPhoto,
      id: 'photo-unlocated',
      fileName: 'unlocated.JPG',
      exif: null,
    } as PhotoRecord
    const folder = {
      id: 'folder-1',
      displayName: 'new',
      parentPath: '/tmp',
      rootPath: '/tmp/new',
    } as FolderRecord
    const records = deriveSpeciesRecords({
      folders: [folder],
      groups: [],
      photos: [gpsPhoto, unlocatedPhoto],
      species: [],
    } as WorkspaceSnapshot)

    const pins = buildArchiveMapPins([gpsPhoto, unlocatedPhoto], records)

    expect(gps).toEqual({ lat: 31.22, lon: 121.48 })
    expect(pins.some((pin) => pin.regionId === 'east' && pin.source === 'gps')).toBe(true)
    expect(pins.flatMap((pin) => pin.photos.map((photo) => photo.id))).not.toContain(
      'photo-unlocated',
    )
  })

  it('keeps protection categories visible before regular collected species', () => {
    const photo = {
      id: 'photo-1',
      folderId: 'folder-1',
      groupId: 'group-1',
      fileName: '5Y3A0001.JPG',
      shotAt: '2026-03-21T15:59:00Z',
      speciesName: '暗绿绣眼鸟',
      speciesLatinName: 'Zosterops simplex',
      speciesEnglishName: "swinhoe's white eye",
      speciesCandidates: [],
      birdCount: 1,
      analysisStatus: 'done',
      grade: 'select',
      decision: null,
      finalScore: 0.78,
    } as PhotoRecord
    const workspace = {
      folders: [],
      groups: [],
      photos: [photo],
      species: [],
    } as WorkspaceSnapshot

    const groups = buildSpeciesCollectionGroups(deriveSpeciesRecords(workspace))
    const groupIds = groups.map((group) => group.id)

    expect(groupIds.slice(0, 2)).toEqual(['protected1', 'protected2'])
    expect(groupIds.indexOf('regular')).toBeGreaterThan(groupIds.indexOf('protected2'))
    expect(groups.find((group) => group.id === 'protected1')?.species).toHaveLength(90)
    expect(groups.find((group) => group.id === 'protected2')?.species).toHaveLength(300)
    expect(groups.find((group) => group.id === 'regular')?.litCount).toBe(1)
  })

  it('scopes the selection review space shortcut away from editing controls', () => {
    const plainSpace = new KeyboardEvent('keydown', { code: 'Space', key: ' ' })
    const metaSpace = new KeyboardEvent('keydown', { code: 'Space', key: ' ', metaKey: true })
    const input = document.createElement('input')
    const normalButton = document.createElement('button')
    const photoButton = document.createElement('button')
    const photoButtonChild = document.createElement('span')

    photoButton.dataset.selectionReviewShortcut = 'true'
    photoButton.append(photoButtonChild)

    expect(isPlainSpaceKey(plainSpace)).toBe(true)
    expect(isPlainSpaceKey(metaSpace)).toBe(false)
    expect(shouldIgnoreSelectionReviewShortcutTarget(input)).toBe(true)
    expect(shouldIgnoreSelectionReviewShortcutTarget(normalButton)).toBe(true)
    expect(shouldIgnoreSelectionReviewShortcutTarget(photoButtonChild)).toBe(false)
  })
})
