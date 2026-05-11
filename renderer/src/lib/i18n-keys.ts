/**
 * 跨组件复用的 i18n key 生成器 — 只放被 components/common 子树消费的几个,
 * 其它仅 App.tsx 内部使用的(routeLabelKey / archiveTabLabelKey / sortLabelKey 等)
 * 留在 App.tsx 作为私有 helper。
 */

import type { PhotoGrade, PoseTagId, ProblemTagId } from '@/lib/mock-workspace'

export function gradeLabelKey(grade: PhotoGrade) {
  return `selection.grade.${grade}` as const
}

export function poseTagKey(tag: PoseTagId) {
  return `selection.poseTags.${tag}` as const
}

export function problemTagKey(tag: ProblemTagId) {
  return `selection.problemTags.${tag}` as const
}
