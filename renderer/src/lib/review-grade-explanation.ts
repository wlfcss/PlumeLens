/**
 * 深度复核的评级依据与阶段状态解释器。
 *
 * 将有效档位、模型基础分档、姿态升降档、人工覆盖，以及无鸟 / 待分析 / 失败等
 * 阶段状态映射为可解释、无歧义的短句，供 ReviewModal 展示。
 */
import type { useTranslation } from 'react-i18next'

import { gradeLabelKey } from '@/lib/i18n-keys'
import { effectivePhotoGrade, formatScore } from '@/lib/photo-helpers'
import type { PhotoGrade, PhotoRecord } from '@/lib/workspace-types'

const GRADE_ORDER: Record<PhotoGrade, number> = {
  reject: 0,
  record: 1,
  usable: 2,
  select: 3,
}

export type GradeExplanationKind =
  | 'failed'
  | 'pending'
  | 'no_bird'
  | 'manual_override'
  | 'pose_downgrade_head'
  | 'pose_downgrade_eye'
  | 'pose_upgrade_flying'
  | 'score_direct'

export interface PhotoGradeExplanation {
  kind: GradeExplanationKind
  summary: string
  detail: string | null
}

export function baseGradeFromScore(score: number | null | undefined): PhotoGrade | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null
  if (score >= 0.75) return 'select'
  if (score >= 0.6) return 'usable'
  if (score >= 0.45) return 'record'
  return 'reject'
}

export function describePhotoGradeExplanation(
  photo: PhotoRecord,
  pose: PhotoRecord['bestPose'] | null | undefined,
  t: ReturnType<typeof useTranslation>['t'],
): PhotoGradeExplanation {
  const effectiveGrade = effectivePhotoGrade(photo)
  const effectiveLabel = t(gradeLabelKey(effectiveGrade))
  const modelLabel = t(gradeLabelKey(photo.grade))

  if (photo.analysisStatus === 'failed') {
    const errorKey = photo.analysisErrorCode
      ? `selection.analysisError.${photo.analysisErrorCode}`
      : null
    const errorText =
      errorKey && t(errorKey) !== errorKey
        ? t(errorKey)
        : (photo.analysisError ?? t('selection.analysisError.unknown'))
    return {
      kind: 'failed',
      summary: t('selection.review.explain.failed'),
      detail: errorText,
    }
  }

  if (photo.analysisStatus === 'pending' || photo.analysisStatus === 'running') {
    return {
      kind: 'pending',
      summary: t('selection.review.explain.pending'),
      detail:
        photo.decision !== null
          ? t('selection.review.explain.manualOnly', { effective: effectiveLabel })
          : null,
    }
  }

  if (photo.birdCount <= 0) {
    return {
      kind: 'no_bird',
      summary: t('selection.review.explain.noBird'),
      detail:
        photo.decision !== null
          ? t('selection.review.explain.manualOverride', {
              effective: effectiveLabel,
              model: modelLabel,
            })
          : null,
    }
  }

  const baseGrade = baseGradeFromScore(photo.finalScore)
  const baseLabel = baseGrade ? t(gradeLabelKey(baseGrade)) : modelLabel
  const scoreText = formatScore(photo.finalScore)

  if (photo.decision !== null) {
    return {
      kind: 'manual_override',
      summary: t('selection.review.explain.manualOverride', {
        effective: effectiveLabel,
        model: modelLabel,
      }),
      detail:
        baseGrade !== null
          ? t('selection.review.explain.baseScoreNote', {
              score: scoreText,
              base: baseLabel,
            })
          : null,
    }
  }

  if (baseGrade !== null && GRADE_ORDER[photo.grade] < GRADE_ORDER[baseGrade]) {
    if (pose?.head_visible === false) {
      return {
        kind: 'pose_downgrade_head',
        summary: t('selection.review.explain.headDowngrade', {
          base: baseLabel,
          model: modelLabel,
        }),
        detail: t('selection.review.explain.baseScoreNote', { score: scoreText, base: baseLabel }),
      }
    }
    if (pose?.eye_visible === false) {
      return {
        kind: 'pose_downgrade_eye',
        summary: t('selection.review.explain.eyeDowngrade', {
          base: baseLabel,
          model: modelLabel,
        }),
        detail: t('selection.review.explain.baseScoreNote', { score: scoreText, base: baseLabel }),
      }
    }
  }

  if (
    baseGrade !== null &&
    GRADE_ORDER[photo.grade] > GRADE_ORDER[baseGrade] &&
    pose?.posture === 'flying'
  ) {
    return {
      kind: 'pose_upgrade_flying',
      summary: t('selection.review.explain.flyingUpgrade', {
        base: baseLabel,
        model: modelLabel,
      }),
      detail: t('selection.review.explain.baseScoreNote', { score: scoreText, base: baseLabel }),
    }
  }

  return {
    kind: 'score_direct',
    summary: t('selection.review.explain.scoreDirect', {
      score: scoreText,
      model: modelLabel,
    }),
    detail: null,
  }
}
