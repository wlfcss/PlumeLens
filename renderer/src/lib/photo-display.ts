/**
 * 照片展示派生 helpers — 跨页面共用(选片 tile / Inspector / 羽迹卡片 / 物种墙等)。
 *
 * - PhotoCategory: PhotoGrade + 'no_bird' 的合并枚举,UI 上"无鸟"和 4 档分级
 *   平级。photoCategory(photo) 把 photo.decision/grade/birdCount 折叠为单值。
 * - gradeTone / categoryTone: 评级 → UI 语义色
 * - effectiveSpeciesSummary: 多鸟图按 detection 维度聚合的物种摘要,把
 *   speciesSource 分桶为 confirmed / unconfirmed / conflict。
 * - tileSpeciesSourceBadge / formatPhotoSpeciesDisplay: 选片 tile 文字徽标
 * - getArchiveSpeciesEntries: 羽迹聚合用,把一张照片折叠为可入羽迹的物种条目
 *   (head 不可见 / unconfirmed / conflict 都不计)
 * - isArchiveEligiblePhoto: 单张照片是否有资格进羽迹(grade ∈ select/usable/record
 *   + birdCount > 0 + analysisStatus 'done')
 */

import type { useTranslation } from 'react-i18next'

import type { FolderStatus, PhotoGrade, PhotoRecord } from '@/lib/mock-workspace'
import {
  effectiveSpeciesName,
  effectivePhotoGrade,
  type Tone,
} from '@/lib/photo-helpers'
import {
  speciesSourceBadge,
  speciesSourceKind,
  type DetectionLike,
} from '@/lib/species-source'
import {
  getSpeciesWiki,
  normalizeSpeciesAlias,
  resolveSpeciesCanonicalSci,
} from '@/lib/species-wiki'

export type PhotoCategory = PhotoGrade | 'no_bird'

const archiveEligibleGrades = new Set<PhotoGrade>(['select', 'usable', 'record'])
const unknownSpeciesAliases = new Set([
  '未识别物种',
  'unidentified',
  'unknown species',
  'unknown',
])

type ArchiveSpeciesEntry = {
  key: string
  name: string
  latinName: string
  englishName: string | null
}

export function photoCategory(photo: PhotoRecord): PhotoCategory {
  if (photo.decision) return photo.decision
  return photo.birdCount === 0 ? 'no_bird' : photo.grade
}

export function gradeTone(grade: PhotoGrade): Tone {
  if (grade === 'select') return 'success'
  if (grade === 'record') return 'warning'
  if (grade === 'reject') return 'accent'
  return 'neutral'
}

export function statusTone(status: FolderStatus): Tone {
  if (status === 'ready') return 'success'
  if (status === 'path_missing' || status === 'error') return 'accent'
  if (status === 'analyzing_partial' || status === 'scanning' || status === 'hashing')
    return 'warning'
  return 'neutral'
}

export function categoryTone(category: PhotoCategory): Tone {
  if (category === 'no_bird') return 'muted'
  return gradeTone(category)
}

export function isArchiveEligiblePhoto(photo: PhotoRecord): boolean {
  return (
    photo.analysisStatus === 'done' &&
    photo.birdCount > 0 &&
    archiveEligibleGrades.has(effectivePhotoGrade(photo))
  )
}

function normalizeArchiveSpeciesEntry(input: {
  englishName?: string | null
  latinName?: string | null
  name?: string | null
}): ArchiveSpeciesEntry | null {
  const resolvedNameLatinName = resolveSpeciesCanonicalSci(input.name)
  const resolvedEnglishLatinName = resolveSpeciesCanonicalSci(input.englishName)
  const resolvedLatinName =
    resolveSpeciesCanonicalSci(input.latinName) ?? resolvedNameLatinName ?? resolvedEnglishLatinName
  const fallbackLatinName = input.latinName?.trim() ?? ''
  const normalizedName = normalizeSpeciesAlias(input.name)
  const isUnknownName = normalizedName ? unknownSpeciesAliases.has(normalizedName) : false
  if (!resolvedLatinName && !fallbackLatinName && (!normalizedName || isUnknownName)) return null

  const latinName = resolvedLatinName ?? fallbackLatinName
  const key = latinName ? `sci:${latinName}` : `name:${normalizedName}`
  const wiki = latinName ? getSpeciesWiki(latinName) : undefined
  const name = wiki?.canonical_zh ?? input.name ?? latinName
  return {
    key,
    name,
    latinName,
    englishName: wiki?.canonical_en ?? input.englishName ?? null,
  }
}

export function getArchiveSpeciesEntries(photo: PhotoRecord): ArchiveSpeciesEntry[] {
  if (!isArchiveEligiblePhoto(photo)) return []
  const rawEntries: Array<{
    englishName?: string | null
    latinName?: string | null
    name?: string | null
  }> = []

  // 优先：按 detection 维度聚合（v6 backend schema：每个 detection 独立 speciesSource）。
  // 多鸟图混合可见性的关键 — head 可见的 detection 进羽迹，head 不可见的不进，
  // 不再被 photo-level 一刀切。
  const detections = photo.birdDetections ?? []
  const detectionsHaveSource = detections.some((d) => d.speciesSource !== undefined)
  if (detectionsHaveSource) {
    for (const detection of detections) {
      const source = detection.speciesSource
      // model_unconfirmed / conflict / none / undefined-with-no-species → 跳过
      if (source === 'model_unconfirmed' || source === 'conflict' || source === 'none') continue
      if (source === undefined && !detection.manualSpecies) continue
      rawEntries.push({
        name: detection.speciesName,
        latinName: detection.speciesLatinName,
        englishName: detection.speciesEnglishName,
      })
    }
  } else {
    // 老数据 fallback（v5 之前没有 detection.speciesSource）— 按 photo-level 走老逻辑
    const manualEntries: typeof rawEntries = []
    for (const detection of detections) {
      if (!detection.manualSpecies) continue
      manualEntries.push({
        name: detection.speciesName,
        latinName: detection.speciesLatinName,
        englishName: detection.speciesEnglishName,
      })
    }
    if (manualEntries.length > 0) {
      rawEntries.push(...manualEntries)
    } else if (photo.manualSpecies || photo.speciesSource === 'manual') {
      rawEntries.push({
        name: photo.speciesName,
        latinName: photo.speciesLatinName,
        englishName: photo.speciesEnglishName,
      })
    } else if (photo.speciesSource === 'model_unconfirmed') {
      // head 不可见 → 不进羽迹（与新逻辑一致）
    } else if (photo.speciesSource === 'group_consensus') {
      rawEntries.push({
        name: photo.groupSpeciesName ?? photo.speciesName,
        latinName: photo.groupSpeciesLatinName ?? photo.speciesLatinName,
        englishName: photo.speciesEnglishName,
      })
    } else {
      rawEntries.push({
        name: photo.modelSpeciesName ?? photo.speciesName,
        latinName: photo.modelSpeciesLatinName ?? photo.speciesLatinName,
        englishName: photo.speciesEnglishName,
      })
    }
  }

  const seen = new Set<string>()
  const entries: ArchiveSpeciesEntry[] = []
  for (const rawEntry of rawEntries) {
    const entry = normalizeArchiveSpeciesEntry(rawEntry)
    if (!entry || seen.has(entry.key)) continue
    seen.add(entry.key)
    entries.push(entry)
  }
  return entries
}

interface SpeciesSummaryEntry {
  name: string | null
  latinName: string | null
  englishName: string | null
  count: number
  isBest: boolean
}

interface SpeciesSummary {
  confirmedEntries: SpeciesSummaryEntry[]
  hasUnconfirmed: boolean
  hasConflict: boolean
  /** 老数据 fallback 标志：detections 全无 speciesSource 字段 → 落回 photo-level */
  fromPhotoLevelFallback: boolean
}

export function effectiveSpeciesSummary(photo: PhotoRecord): SpeciesSummary {
  const detections = photo.birdDetections ?? []
  const detectionsHaveSource = detections.some((d) => d.speciesSource !== undefined)
  if (!detectionsHaveSource) {
    return {
      confirmedEntries: [],
      hasUnconfirmed: false,
      hasConflict: false,
      fromPhotoLevelFallback: true,
    }
  }
  const map = new Map<string, SpeciesSummaryEntry>()
  let hasUnconfirmed = false
  let hasConflict = false
  for (const d of detections) {
    const source = d.speciesSource
    if (source === 'model_unconfirmed') {
      hasUnconfirmed = true
      continue
    }
    if (source === 'conflict') {
      hasConflict = true
      continue
    }
    if (source === 'none' || !d.speciesName) continue
    const key = d.speciesLatinName ?? d.speciesName ?? ''
    if (!key) continue
    const existing = map.get(key)
    if (existing) {
      existing.count += 1
      if (d.isBest) existing.isBest = true
    } else {
      map.set(key, {
        name: d.speciesName,
        latinName: d.speciesLatinName ?? null,
        englishName: d.speciesEnglishName ?? null,
        count: 1,
        isBest: d.isBest,
      })
    }
  }
  const confirmedEntries = [...map.values()].sort((a, b) => {
    if (a.isBest && !b.isBest) return -1
    if (!a.isBest && b.isBest) return 1
    return b.count - a.count
  })
  return {
    confirmedEntries,
    hasUnconfirmed,
    hasConflict,
    fromPhotoLevelFallback: false,
  }
}

function bestDetectionWithSource(photo: PhotoRecord): DetectionLike | null {
  const detections = photo.birdDetections ?? []
  return (
    detections.find((d) => d.isBest && d.speciesSource !== undefined) ??
    detections.find((d) => d.speciesSource !== undefined) ??
    null
  )
}

// 多鸟图 tile 来源徽标策略：
// - 有 detection-level source 时，优先用 best detection 判定待审成因
// - 多源混合且包含 unconfirmed → "部分待审"（warning 色，复用 unconfirmed CSS）
// - 多源混合不含 unconfirmed → 取最高优先级 source 的 badge（manual > group_consensus > model）
// - 老数据无 detection source → 走 photo-level fallback。
export function tileSpeciesSourceBadge(
  photo: PhotoRecord,
  t: ReturnType<typeof useTranslation>['t'],
): { label: string; kind: 'conflict' | 'correction' | 'manual' | 'unconfirmed' } | null {
  const summary = effectiveSpeciesSummary(photo)
  if (summary.fromPhotoLevelFallback) {
    const label = speciesSourceBadge(photo, t)
    const kind = speciesSourceKind(photo)
    return label && kind ? { label, kind } : null
  }
  // 多源混合且有 unconfirmed → 部分待审
  if (summary.hasUnconfirmed && summary.confirmedEntries.length > 0) {
    return {
      label: t('selection.speciesSource.partialUnconfirmed'),
      kind: 'unconfirmed',
    }
  }
  const bestDetection = bestDetectionWithSource(photo)
  const label = speciesSourceBadge(photo, t, bestDetection)
  const kind = speciesSourceKind(photo, bestDetection)
  return label && kind ? { label, kind } : null
}

// 选片 tile / 物种照片浏览统一用的物种文本格式化函数。
// 把 effectiveSpeciesSummary 的纯数据 + photo 状态 + i18n 拼成可显示字符串。
export function formatPhotoSpeciesDisplay(
  photo: PhotoRecord,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (photo.analysisStatus === 'pending') return t('selection.analysisStatus.pending')
  if (photo.analysisStatus === 'running') return t('selection.analysisStatus.running')
  if (photo.analysisStatus === 'failed') return t('selection.analysisStatus.failed')
  if (photo.birdCount === 0) return t('selection.photo.noBird')

  const summary = effectiveSpeciesSummary(photo)
  if (summary.fromPhotoLevelFallback) {
    return effectiveSpeciesName(photo) ?? t('selection.photo.unidentified')
  }
  const entries = summary.confirmedEntries
  if (entries.length === 0) {
    // 全 unconfirmed / conflict / none → 仍展示模型识别物种（待审标在外面 source badge）
    return effectiveSpeciesName(photo) ?? t('selection.photo.unidentified')
  }
  if (entries.length === 1) {
    const e = entries[0]
    return e.count > 1
      ? t('selection.photo.speciesTimes', { name: e.name ?? '', count: e.count })
      : (e.name ?? t('selection.photo.unidentified'))
  }
  if (entries.length === 2) {
    return t('selection.photo.speciesPlus', {
      a: entries[0].name ?? '',
      b: entries[1].name ?? '',
    })
  }
  return t('selection.photo.speciesEtc', {
    name: entries[0].name ?? '',
    count: entries.length,
  })
}
