/**
 * speciesSourceDetail 文案分支回归 — 防止再次出现"鸟头不可见"误报。
 *
 * model_unconfirmed 在 engine 端有两条独立成因:
 *   (a) v4 reject head: candidate.recognitionState === 'uncertain'
 *   (b) head 不可见: pose.head_visible === false
 * 之前一律展示 (b) 文案,在 (a) 场景跟 head ✓ UI 直接矛盾(用户实测截图)。
 * 现在 speciesSourceDetail / speciesSourceBadge 按实际成因分流,本测试锁定行为。
 */
import { describe, expect, it } from 'vitest'

import { speciesSourceBadge, speciesSourceDetail } from '@/lib/species-source'
import type { PhotoRecord } from '@/lib/workspace-types'

type Detection = NonNullable<PhotoRecord['birdDetections']>[number]
const tFake = (key: string): string => key

function makePhoto(overrides: Partial<PhotoRecord> = {}): PhotoRecord {
  return {
    id: 'p1',
    folderId: 'f1',
    groupId: 'g1',
    fileName: 'IMG.jpg',
    filePath: '/x/y/IMG.jpg',
    shotAt: '2026-01-01T00:00:00Z',
    camera: '',
    lens: '',
    speciesName: '印度寿带',
    speciesLatinName: 'Terpsiphone paradisi',
    manualSpecies: false,
    speciesSource: 'model_unconfirmed',
    modelSpeciesName: '印度寿带',
    modelSpeciesLatinName: 'Terpsiphone paradisi',
    groupSpeciesName: null,
    groupSpeciesLatinName: null,
    groupSpeciesConfidence: null,
    groupSpeciesSupport: null,
    groupSpeciesEvidence: null,
    groupSpeciesTotal: null,
    speciesConflict: false,
    speciesCandidates: [],
    birdDetections: [],
    isNewSpecies: false,
    birdCount: 1,
    grade: 'usable',
    decision: null,
    finalScore: 0.74,
    semanticScore: null,
    technicalScore: null,
    poseScore: null,
    analysisStatus: 'done',
    analysisErrorCode: null,
    analysisError: null,
    poseTags: [],
    problemTags: [],
    sceneTag: 'record_shot',
    caption: '',
    previewGradient: '',
    placeholderGradient: '',
    thumbGridUrl: null,
    boxes: [],
    imageWidth: 0,
    imageHeight: 0,
    thumbPreviewUrl: null,
    exif: null,
    bestBbox: null,
    bestPose: null,
    bestAfPoint: null,
    bestAfArea: null,
    companionPath: null,
    companionFormat: null,
    companionSize: null,
    country: null,
    province: null,
    city: null,
    district: null,
    place: null,
    ...overrides,
  } as PhotoRecord
}

function makeDetection(overrides: Partial<Detection> = {}): Detection {
  return {
    index: 0,
    bbox: { x1: 0, y1: 0, x2: 100, y2: 100, confidence: 0.96 },
    pose: null,
    speciesName: '印度寿带',
    speciesLatinName: 'Terpsiphone paradisi',
    speciesCandidates: [],
    manualSpecies: false,
    isBest: true,
    speciesSource: 'model_unconfirmed',
    ...overrides,
  } as Detection
}

describe('speciesSourceDetail — model_unconfirmed cause differentiation', () => {
  it('reject head uncertain → uncertain 文案', () => {
    const photo = makePhoto()
    const detection = makeDetection({
      pose: {
        bill: { x: 0, y: 0, confidence: 0.9 },
        crown: { x: 0, y: 0, confidence: 0.9 },
        nape: { x: 0, y: 0, confidence: 0.9 },
        left_eye: { x: 0, y: 0, confidence: 0.8 },
        right_eye: { x: 0, y: 0, confidence: 0.8 },
        head_visible: true, // 头是可见的
        eye_visible: true,
      },
      speciesCandidates: [
        {
          name: '印度寿带',
          latinName: 'Terpsiphone paradisi',
          confidence: 0.96,
          recognitionState: 'uncertain', // reject head 不确定
        },
      ],
    })
    const detail = speciesSourceDetail(photo, tFake, detection)
    expect(detail).toBe('selection.speciesSource.unconfirmedUncertainDetail')
    const badge = speciesSourceBadge(photo, tFake, detection)
    expect(badge).toBe('selection.speciesSource.unconfirmedSpecies')
  })

  it('head invisible → head 文案', () => {
    const photo = makePhoto()
    const detection = makeDetection({
      pose: {
        bill: { x: 0, y: 0, confidence: 0.1 },
        crown: { x: 0, y: 0, confidence: 0.1 },
        nape: { x: 0, y: 0, confidence: 0.1 },
        left_eye: { x: 0, y: 0, confidence: 0.1 },
        right_eye: { x: 0, y: 0, confidence: 0.1 },
        head_visible: false, // head 不可见
        eye_visible: false,
      },
      speciesCandidates: [
        {
          name: '印度寿带',
          latinName: 'Terpsiphone paradisi',
          confidence: 0.96,
          recognitionState: 'recognized',
        },
      ],
    })
    const detail = speciesSourceDetail(photo, tFake, detection)
    expect(detail).toBe('selection.speciesSource.unconfirmedHeadDetail')
    const badge = speciesSourceBadge(photo, tFake, detection)
    expect(badge).toBe('selection.speciesSource.unconfirmedIncomplete')
  })

  it('uncertain + head invisible → uncertain 文案优先(reject head 是更直接的成因)', () => {
    const photo = makePhoto()
    const detection = makeDetection({
      pose: {
        bill: { x: 0, y: 0, confidence: 0.1 },
        crown: { x: 0, y: 0, confidence: 0.1 },
        nape: { x: 0, y: 0, confidence: 0.1 },
        left_eye: { x: 0, y: 0, confidence: 0.1 },
        right_eye: { x: 0, y: 0, confidence: 0.1 },
        head_visible: false,
        eye_visible: false,
      },
      speciesCandidates: [
        {
          name: '印度寿带',
          latinName: 'Terpsiphone paradisi',
          confidence: 0.5,
          recognitionState: 'uncertain',
        },
      ],
    })
    const detail = speciesSourceDetail(photo, tFake, detection)
    expect(detail).toBe('selection.speciesSource.unconfirmedUncertainDetail')
  })

  it('photo-level fallback 使用 photo candidates / bestPose 判定，不误报不全', () => {
    const photo = makePhoto({
      bestPose: {
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
          name: '印度寿带',
          latinName: 'Terpsiphone paradisi',
          confidence: 0.96,
          recognitionState: 'uncertain',
        },
      ],
    })
    const detail = speciesSourceDetail(photo, tFake)
    const badge = speciesSourceBadge(photo, tFake)
    expect(detail).toBe('selection.speciesSource.unconfirmedUncertainDetail')
    expect(badge).toBe('selection.speciesSource.unconfirmedSpecies')
  })

  it('pose missing → 当 head 不可见处理(老数据兼容)', () => {
    const photo = makePhoto()
    const detection = makeDetection({
      pose: null,
      speciesCandidates: [
        {
          name: '印度寿带',
          latinName: 'Terpsiphone paradisi',
          confidence: 0.96,
          recognitionState: 'recognized',
        },
      ],
    })
    const detail = speciesSourceDetail(photo, tFake, detection)
    expect(detail).toBe('selection.speciesSource.unconfirmedHeadDetail')
  })

  it('non-unconfirmed source 不进新分支 — manual', () => {
    const photo = makePhoto({ speciesSource: 'manual', manualSpecies: true })
    const detection = makeDetection({ speciesSource: 'manual' })
    const detail = speciesSourceDetail(photo, tFake, detection)
    expect(detail).toBe('selection.speciesSource.manualDetail')
  })
})
