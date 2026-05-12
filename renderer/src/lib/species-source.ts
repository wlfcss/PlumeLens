/**
 * 物种来源相关 helpers — 根据 photo.speciesSource 与 photo.manualSpecies 决定 tone /
 * 类别 / 徽标文字 / 详情提示。
 *
 * 多鸟图深度复核切鸟时,ScoreHeader 会把当前 activeBird detection 传进来;其他场景
 * (PhotoTile / CompareModal)按 photo-level 兜底。
 *
 * 历史:之前定义在 App.tsx,被 review-modal.tsx 反向 import,是 commit f9604ed 遗留
 * 的过渡状态。本文件把这个簇剥离,反转 import 方向。
 */

import type { useTranslation } from 'react-i18next'

import type { PhotoRecord } from '@/lib/mock-workspace'

import { effectiveSpeciesName, type Tone } from './photo-helpers'

export type DetectionLike = NonNullable<PhotoRecord['birdDetections']>[number]
type UnconfirmedSpeciesCause = 'uncertain' | 'head' | 'generic'

function resolveSourceFor(
  photo: PhotoRecord,
  detection?: DetectionLike | null,
): { source: PhotoRecord['speciesSource']; manualSpecies: boolean } {
  if (detection) {
    const source =
      photo.speciesSource === 'group_consensus' && detection.isBest && !detection.manualSpecies
        ? photo.speciesSource
        : detection.speciesSource
    return {
      source,
      manualSpecies: detection.manualSpecies,
    }
  }
  return {
    source: photo.speciesSource,
    manualSpecies: photo.manualSpecies ?? false,
  }
}

function speciesUnconfirmedCause(
  photo: PhotoRecord,
  detection?: DetectionLike | null,
): UnconfirmedSpeciesCause | null {
  const { source } = resolveSourceFor(photo, detection)
  if (source !== 'model_unconfirmed') return null

  const top = detection?.speciesCandidates?.[0] ?? photo.speciesCandidates?.[0]
  if (top?.recognitionState === 'uncertain') return 'uncertain'

  const pose = detection?.pose ?? photo.bestPose ?? null
  if (!pose || !pose.head_visible) return 'head'

  return 'generic'
}

export function speciesSourceTone(photo: PhotoRecord, detection?: DetectionLike | null): Tone {
  const { source, manualSpecies } = resolveSourceFor(photo, detection)
  if (source === 'group_consensus') return 'success'
  if (photo.speciesConflict || source === 'conflict') return 'warning'
  if (source === 'model_unconfirmed') return 'warning'
  if (source === 'manual' || manualSpecies) return 'accent'
  return 'muted'
}

export function speciesSourceKind(
  photo: PhotoRecord,
  detection?: DetectionLike | null,
): 'conflict' | 'correction' | 'manual' | 'unconfirmed' | null {
  const { source, manualSpecies } = resolveSourceFor(photo, detection)
  if (source === 'group_consensus') return 'correction'
  if (photo.speciesConflict || source === 'conflict') return 'conflict'
  if (source === 'model_unconfirmed') return 'unconfirmed'
  if (source === 'manual' || manualSpecies) return 'manual'
  return null
}

export function speciesSourceBadge(
  photo: PhotoRecord,
  t: ReturnType<typeof useTranslation>['t'],
  detection?: DetectionLike | null,
): string | null {
  const { source, manualSpecies } = resolveSourceFor(photo, detection)
  if (source === 'group_consensus') {
    return t('selection.speciesSource.groupConsensus')
  }
  if (photo.speciesConflict || source === 'conflict') {
    return t('selection.speciesSource.conflict')
  }
  if (source === 'model_unconfirmed') {
    const cause = speciesUnconfirmedCause(photo, detection)
    if (cause === 'uncertain') return t('selection.speciesSource.unconfirmedSpecies')
    if (cause === 'head') return t('selection.speciesSource.unconfirmedIncomplete')
    return t('selection.speciesSource.unconfirmedGeneric')
  }
  if (source === 'manual' || manualSpecies) {
    return t('selection.speciesSource.manual')
  }
  return null
}

export function speciesSourceDetail(
  photo: PhotoRecord,
  t: ReturnType<typeof useTranslation>['t'],
  detection?: DetectionLike | null,
): string | null {
  const { source, manualSpecies } = resolveSourceFor(photo, detection)
  const support =
    photo.groupSpeciesSupport !== null &&
    photo.groupSpeciesSupport !== undefined &&
    photo.groupSpeciesEvidence !== null &&
    photo.groupSpeciesEvidence !== undefined
      ? `${photo.groupSpeciesSupport}/${photo.groupSpeciesEvidence}`
      : '--'
  const raw = photo.modelSpeciesName
  const effective = effectiveSpeciesName(photo)

  if (source === 'group_consensus') {
    if (raw && raw !== effective) {
      return t('selection.speciesSource.groupConsensusWithRaw', { species: raw, support })
    }
    return t('selection.speciesSource.groupConsensusDetail', { support })
  }
  if (photo.speciesConflict || source === 'conflict') {
    return t('selection.speciesSource.conflictDetail')
  }
  if (source === 'model_unconfirmed') {
    const cause = speciesUnconfirmedCause(photo, detection)
    if (cause === 'uncertain') {
      return t('selection.speciesSource.unconfirmedUncertainDetail')
    }
    if (cause === 'head') {
      return t('selection.speciesSource.unconfirmedHeadDetail')
    }
    return t('selection.speciesSource.unconfirmedGenericDetail')
  }
  if (source === 'manual' || manualSpecies) {
    return t('selection.speciesSource.manualDetail')
  }
  return null
}
