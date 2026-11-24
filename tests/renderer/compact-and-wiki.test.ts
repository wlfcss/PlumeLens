import { describe, expect, it } from 'vitest'
import {
  hydrateCompactSummaryRow,
  normalizeLibraryRootPrefix,
} from '../../shared/library-summary-stream'
import {
  getLoadedSpeciesWikiBody,
  getSpeciesWiki,
  listAllSpecies,
  loadSpeciesWikiBodies,
} from '@/lib/species-wiki'

describe('compact-v1 summary hydration & lazy species wiki bodies', () => {
  it('losslessly expands compact-v1 rows including relative paths and best_detection', () => {
    const prefix = normalizeLibraryRootPrefix('/Volumes/Photos/2026-11')
    const hydrated = hydrateCompactSummaryRow<Record<string, unknown>>(
      {
        id: 'p1',
        rel_path: 'IMG_0001.JPG',
        rel_companion_path: 'IMG_0001.CR3',
        file_name: 'IMG_0001.JPG',
        created_at: '2026-11-20T08:00:00',
        shot_at: '2026-11-20T08:00:00',
        analysis_status: 'done',
        grade: 'select',
        quality_score: 0.84,
        bird_count: 1,
        species: '普通翠鸟',
        species_latin: 'Alcedo atthis',
        species_source: 'model',
        detections: [
          {
            index: 0,
            bbox: { x1: 1, y1: 2, x2: 3, y2: 4, confidence: 0.9 },
            pose: { head_visible: true, eye_visible: true, posture: 'flying' },
            species: '普通翠鸟',
            species_latin: 'Alcedo atthis',
            species_source: 'model',
            is_best: true,
          },
        ],
      },
      prefix,
    )
    expect(hydrated.file_path).toBe('/Volumes/Photos/2026-11/IMG_0001.JPG')
    expect(hydrated.companion_path).toBe('/Volumes/Photos/2026-11/IMG_0001.CR3')
    expect(hydrated.best_detection).toMatchObject({
      index: 0,
      species: '普通翠鸟',
      pose: { head_visible: true, eye_visible: true, posture: 'flying', body_visible: false },
    })
    expect((hydrated.best_detection as Record<string, unknown>).is_best).toBeUndefined()
  })

  it('keeps sync species catalog lightweight and loads wiki extracts lazily', async () => {
    const all = listAllSpecies()
    expect(all.length).toBeGreaterThan(1500)
    const kingfisherBefore = getSpeciesWiki('Alcedo atthis')
    expect(kingfisherBefore?.canonical_zh).toBe('普通翠鸟')
    expect(kingfisherBefore?.zh_extract).toBeNull()
    await loadSpeciesWikiBodies()
    const body = getLoadedSpeciesWikiBody('Alcedo atthis')
    expect(body).toBeDefined()
    expect(Boolean(body?.zh_extract || body?.en_extract)).toBe(true)
    const kingfisherAfter = getSpeciesWiki('Alcedo atthis')
    expect(Boolean(kingfisherAfter?.zh_extract || kingfisherAfter?.en_extract)).toBe(true)
  })
})
