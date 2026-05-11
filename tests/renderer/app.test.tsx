import React from 'react'
import { act, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import '@/i18n'
import App, {
  applyNewSpeciesMarkers,
  buildArchiveMapPins,
  buildGroupStartMsMap,
  buildReviewPhotoOrderForGroup,
  buildSpeciesCollectionGroups,
  deriveSpeciesRecords,
  extractPhotoGps,
  isPlainSpaceKey,
  pipelineRuntimeFromProvider,
  shouldIgnoreSelectionReviewShortcutTarget,
} from '@/App'
import {
  effectiveSpeciesSummary,
  getArchiveSpeciesEntries,
  tileSpeciesSourceBadge,
} from '@/lib/photo-display'
import i18next from 'i18next'
import { listAllSpecies, resolveSpeciesCanonicalSci } from '@/lib/species-wiki'
import type {
  FolderRecord,
  PhotoGroupRecord,
  PhotoRecord,
  WorkspaceSnapshot,
} from '@/lib/mock-workspace'

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
    // app.test 测 React 集成,api-client 没有 preload engineRequest 时会自动
    // fallback 直 fetch(测试用 msw 拦截),保持 stub 极简。
    getAppVersion: async () => '0.1.0',
    checkForUpdates: async () => ({
      ok: true,
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      hasUpdate: false,
      releaseUrl: 'https://github.com/wlfcss/PlumeLens/releases/tag/v0.1.0',
      releaseName: 'v0.1.0',
      publishedAt: '2026-04-01T00:00:00Z',
    }),
    openFolder: async () => null,
    selectExportDirectory: async () => null,
    openLogsDir: async () => '',
    openPathInFinder: async () => ({ ok: true }),
    openExternalUrl: async () => ({ ok: true }),
    onBackendReady: () => {},
    onBackendError: () => {},
    onEngineStatus: () => () => {},
    listEditors: async () => ({ topaz: null, photoshop: null }),
    openInEditor: async () => ({ ok: false, reason: 'not_installed' }),
    getUserSettings: async () => ({}),
    saveUserSettings: async (partial) => ({ ok: true, settings: partial }),
    restartEngine: async () => true,
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

    expect(allSpecies).toHaveLength(1591)
    expect(modelExtras).toHaveLength(77)
    expect(modelExtras.every((species) => species.is_trained)).toBe(true)
    expect(modelExtras.map((species) => species.canonical_sci)).toContain('Agapornis fischeri')
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

  it('derives group start time from all photos instead of current group order', () => {
    const starts = buildGroupStartMsMap([
      { groupId: 'older', shotAt: '2026-04-24T09:30:00Z' },
      { groupId: 'older', shotAt: '2026-04-24T09:00:00Z' },
      { groupId: 'newer', shotAt: '2026-04-24T10:15:00Z' },
      { groupId: 'newer', shotAt: '2026-04-24T10:00:00Z' },
    ])

    expect(new Date(starts.get('older') ?? 0).toISOString()).toBe('2026-04-24T09:00:00.000Z')
    expect(new Date(starts.get('newer') ?? 0).toISOString()).toBe('2026-04-24T10:00:00.000Z')
    expect(
      ['older', 'newer'].toSorted(
        (left, right) =>
          (starts.get(right) ?? Number.NEGATIVE_INFINITY) -
          (starts.get(left) ?? Number.NEGATIVE_INFINITY),
      ),
    ).toEqual(['newer', 'older'])
  })

  it('orders grouped review filmstrip by outer segment order instead of score order', () => {
    const makePhoto = (id: string, shotAt: string, score: number) =>
      ({
        id,
        folderId: 'folder-1',
        groupId: 'group-1',
        fileName: `${id}.JPG`,
        shotAt,
        speciesName: '印度寿带',
        speciesLatinName: 'Terpsiphone paradisi',
        birdCount: 1,
        analysisStatus: 'done',
        grade: score >= 0.75 ? 'select' : 'usable',
        decision: null,
        finalScore: score,
        bestBbox: { x1: 100, y1: 100, x2: 300, y2: 400, confidence: 0.9 },
        imageWidth: 1000,
        imageHeight: 800,
      }) as PhotoRecord

    const photos = [
      makePhoto('third-high-score', '2026-04-24T09:00:02Z', 0.92),
      makePhoto('first-low-score', '2026-04-24T09:00:00Z', 0.61),
      makePhoto('second-mid-score', '2026-04-24T09:00:01Z', 0.74),
    ]

    expect(buildReviewPhotoOrderForGroup(photos).map((photo) => photo.id)).toEqual([
      'first-low-score',
      'second-mid-score',
      'third-high-score',
    ])
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
    expect(
      records.find((species) => species.latinName === 'Phylloscopus inornatus')?.collected,
    ).toBe(false)
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

  it('aggregates multi-species in tile display: × N / + / 等 N 种', () => {
    // 单鸟图: 按 photo-level fallback
    const singleBird = {
      id: 'p-single',
      birdDetections: [
        {
          index: 0,
          bbox: { x1: 0, y1: 0, x2: 1, y2: 1, confidence: 0.9 },
          speciesName: '白鹭',
          speciesLatinName: 'Egretta garzetta',
          speciesCandidates: [],
          manualSpecies: false,
          isBest: true,
          speciesSource: 'model',
        },
      ],
      birdCount: 1,
      analysisStatus: 'done',
      grade: 'select',
      decision: null,
      finalScore: 0.78,
      speciesName: '白鹭',
      speciesLatinName: 'Egretta garzetta',
    } as PhotoRecord
    expect(effectiveSpeciesSummary(singleBird).confirmedEntries.map((e) => e.name)).toEqual([
      '白鹭',
    ])

    // 多鸟同物种 (× 2)
    const sameSpecies = {
      ...singleBird,
      id: 'p-same',
      birdCount: 2,
      birdDetections: [
        { ...singleBird.birdDetections![0], index: 0, isBest: true },
        { ...singleBird.birdDetections![0], index: 1, isBest: false },
      ],
    } as PhotoRecord
    const sameSummary = effectiveSpeciesSummary(sameSpecies)
    expect(sameSummary.confirmedEntries).toHaveLength(1)
    expect(sameSummary.confirmedEntries[0].count).toBe(2)
    expect(sameSummary.confirmedEntries[0].name).toBe('白鹭')

    // 多鸟多物种 (best 优先)
    const mixedSpecies = {
      ...singleBird,
      id: 'p-mixed',
      birdCount: 2,
      birdDetections: [
        {
          ...singleBird.birdDetections![0],
          index: 0,
          isBest: true,
          speciesName: '白鹭',
          speciesLatinName: 'Egretta garzetta',
        },
        {
          ...singleBird.birdDetections![0],
          index: 1,
          isBest: false,
          speciesName: '苍鹭',
          speciesLatinName: 'Ardea cinerea',
        },
      ],
    } as PhotoRecord
    const mixedSummary = effectiveSpeciesSummary(mixedSpecies)
    expect(mixedSummary.confirmedEntries.map((e) => e.name)).toEqual(['白鹭', '苍鹭'])
    expect(mixedSummary.hasUnconfirmed).toBe(false)

    // 多鸟混合: best 是 model + 另一只 model_unconfirmed → "部分待审"
    const partialUnconfirmed = {
      ...mixedSpecies,
      id: 'p-partial',
      birdDetections: [
        { ...mixedSpecies.birdDetections![0], speciesSource: 'model' },
        { ...mixedSpecies.birdDetections![1], speciesSource: 'model_unconfirmed' },
      ],
    } as PhotoRecord
    const partialSummary = effectiveSpeciesSummary(partialUnconfirmed)
    expect(partialSummary.confirmedEntries.map((e) => e.name)).toEqual(['白鹭'])
    expect(partialSummary.hasUnconfirmed).toBe(true)
    // tile 徽标策略：partial unconfirmed 时使用专门的 partialUnconfirmed 标签
    const partialBadge = tileSpeciesSourceBadge(
      partialUnconfirmed,
      i18next.t.bind(i18next) as never,
    )
    expect(partialBadge?.kind).toBe('unconfirmed')

    // 全部 detection 都是待审时，tile 也必须按 best detection 的真实成因显示；
    // 不能退回 photo-level 后因为缺 pose/candidates 误报成"不全 · 待审"。
    const allUnconfirmedUncertain = {
      ...singleBird,
      id: 'p-all-unconfirmed-uncertain',
      speciesSource: 'model_unconfirmed',
      speciesCandidates: [],
      birdDetections: [
        {
          ...singleBird.birdDetections![0],
          speciesSource: 'model_unconfirmed',
          pose: {
            bill: { x: 0, y: 0, confidence: 0.9 },
            crown: { x: 0, y: 0, confidence: 0.9 },
            nape: { x: 0, y: 0, confidence: 0.9 },
            left_eye: { x: 0, y: 0, confidence: 0.8 },
            right_eye: { x: 0, y: 0, confidence: 0.8 },
            head_visible: true,
            eye_visible: true,
          },
          speciesCandidates: [
            {
              name: '白鹭',
              latinName: 'Egretta garzetta',
              confidence: 0.61,
              recognitionState: 'uncertain',
            },
          ],
        },
      ],
    } as PhotoRecord
    const uncertainBadge = tileSpeciesSourceBadge(
      allUnconfirmedUncertain,
      i18next.t.bind(i18next) as never,
    )
    expect(uncertainBadge).toEqual({ label: '物种待审', kind: 'unconfirmed' })
  })

  it('aggregates multi-bird mixed visibility per detection (v6 detection-level)', () => {
    // 关键：多鸟图中 head 可见的 detection 进羽迹，head 不可见的不进，
    // 不被 photo-level 一刀切。photo.speciesSource 由 best detection 决定，
    // 但羽迹聚合按 detection 维度。
    const photo = {
      id: 'photo-multi-mixed',
      folderId: 'folder-1',
      groupId: 'group-1',
      fileName: '5Y3A0020.JPG',
      shotAt: '2026-04-30T10:00:00Z',
      speciesName: '白鹭', // best detection 的物种
      speciesLatinName: 'Egretta garzetta',
      speciesSource: 'model', // best detection head 可见
      modelSpeciesName: '白鹭',
      modelSpeciesLatinName: 'Egretta garzetta',
      birdDetections: [
        {
          index: 0,
          bbox: { x1: 0, y1: 0, x2: 100, y2: 100, confidence: 0.9 },
          speciesName: '白鹭',
          speciesLatinName: 'Egretta garzetta',
          speciesCandidates: [],
          manualSpecies: false,
          speciesSource: 'model', // head 可见
          isBest: true,
        },
        {
          index: 1,
          bbox: { x1: 200, y1: 0, x2: 300, y2: 100, confidence: 0.8 },
          speciesName: '苍鹭',
          speciesLatinName: 'Ardea cinerea',
          speciesCandidates: [],
          manualSpecies: false,
          speciesSource: 'model_unconfirmed', // head 不可见
          isBest: false,
        },
      ],
      birdCount: 2,
      analysisStatus: 'done',
      grade: 'select',
      decision: null,
      finalScore: 0.83,
    } as PhotoRecord
    const workspace = {
      folders: [],
      groups: [],
      photos: [photo],
      species: [],
    } as WorkspaceSnapshot

    const entries = getArchiveSpeciesEntries(photo)
    const records = deriveSpeciesRecords(workspace)

    // 白鹭（detection 0, head 可见, 'model'）进羽迹；
    // 苍鹭（detection 1, head 不可见, 'model_unconfirmed'）不进
    expect(entries.map((e) => e.latinName).sort()).toEqual(['Egretta garzetta'])
    expect(records.find((s) => s.latinName === 'Egretta garzetta')?.collected).toBe(true)
    expect(records.find((s) => s.latinName === 'Ardea cinerea')?.collected).toBe(false)
  })

  it('excludes model_unconfirmed species from archive collection until user confirms', () => {
    // 不变量：head 不可见时 species_source='model_unconfirmed'，
    // 该照片即使是精选档也不应让该物种"已点亮"。用户在深度复核确认后
    // 升级为 'manual' 才应入羽迹。
    const unconfirmedPhoto = {
      id: 'photo-unconfirmed',
      folderId: 'folder-1',
      groupId: 'group-1',
      fileName: '5Y3A0011.JPG',
      shotAt: '2026-03-21T15:59:00Z',
      speciesName: '白鹭',
      speciesLatinName: 'Egretta garzetta',
      speciesSource: 'model_unconfirmed',
      modelSpeciesName: '白鹭',
      modelSpeciesLatinName: 'Egretta garzetta',
      birdCount: 1,
      analysisStatus: 'done',
      grade: 'select',
      decision: null,
      finalScore: 0.78,
    } as PhotoRecord
    const workspace = {
      folders: [],
      groups: [],
      photos: [unconfirmedPhoto],
      species: [],
    } as WorkspaceSnapshot

    const entries = getArchiveSpeciesEntries(unconfirmedPhoto)
    const records = deriveSpeciesRecords(workspace)
    const egretta = records.find((species) => species.latinName === 'Egretta garzetta')

    expect(entries).toEqual([])
    expect(egretta?.collected).toBe(false)
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

  it('marks all photos of a new species within its first encounter group only', () => {
    const makePhoto = (
      id: string,
      groupId: string,
      speciesName: string,
      speciesLatinName: string,
      shotAt: string,
    ) =>
      ({
        id,
        folderId: 'folder-1',
        groupId,
        fileName: `${id}.JPG`,
        shotAt,
        speciesName,
        speciesLatinName,
        speciesSource: 'model_recognized',
        birdCount: 1,
        analysisStatus: 'done',
        grade: 'usable',
        decision: null,
        finalScore: 0.7,
        isNewSpecies: false,
      }) as PhotoRecord

    const groups = [
      { id: 'group-old', folderId: 'folder-1', containsNewSpecies: false },
      { id: 'group-first', folderId: 'folder-1', containsNewSpecies: false },
      { id: 'group-later', folderId: 'folder-1', containsNewSpecies: false },
    ] as PhotoGroupRecord[]
    const { photos, groups: markedGroups } = applyNewSpeciesMarkers(
      [
        makePhoto('old-1', 'group-old', '白鹭', 'Egretta garzetta', '2026-04-01T00:00:00Z'),
        makePhoto('new-1', 'group-first', '池鹭', 'Ardeola bacchus', '2026-04-02T00:00:00Z'),
        makePhoto('new-2', 'group-first', '池鹭', 'Ardeola bacchus', '2026-04-02T00:00:01Z'),
        makePhoto('old-2', 'group-first', '白鹭', 'Egretta garzetta', '2026-04-02T00:00:02Z'),
        makePhoto('later-1', 'group-later', '池鹭', 'Ardeola bacchus', '2026-04-03T00:00:00Z'),
      ],
      groups,
    )

    expect(Object.fromEntries(photos.map((photo) => [photo.id, photo.isNewSpecies]))).toEqual({
      'old-1': true,
      'new-1': true,
      'new-2': true,
      'old-2': false,
      'later-1': false,
    })
    expect(
      Object.fromEntries(markedGroups.map((group) => [group.id, group.containsNewSpecies])),
    ).toEqual({
      'group-old': true,
      'group-first': true,
      'group-later': false,
    })
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
    expect(groups.find((group) => group.id === 'protected1')?.species).toHaveLength(87)
    expect(groups.find((group) => group.id === 'protected2')?.species).toHaveLength(295)
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

  it('derives pipeline device labels from backend providers', () => {
    expect(pipelineRuntimeFromProvider('CPUExecutionProvider')).toMatchObject({
      device: 'cpu',
      providerLabel: 'CPU',
    })
    expect(pipelineRuntimeFromProvider('CoreMLExecutionProvider')).toMatchObject({
      device: 'gpu',
      providerLabel: 'CoreML',
    })
    expect(pipelineRuntimeFromProvider('torch:mps:torch.bfloat16')).toMatchObject({
      device: 'mps',
      providerLabel: 'MPS',
    })
  })
})
