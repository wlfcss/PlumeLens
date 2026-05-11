/**
 * 照片相关的纯辅助函数与基础 UI 类型。
 *
 * 历史:这些 helper 之前定义在 App.tsx,被 review-modal.tsx 反向 import,是 commit
 * f9604ed("拆分 ReviewModal 子树到独立文件")遗留的过渡状态。本文件把这些纯函数
 * 从 App.tsx 剥离,反转 import 方向。
 */

import type { AfOverlay, PhotoGrade, PhotoGroupRecord, PhotoRecord } from '@/lib/mock-workspace'

// 全局 UI 语义色调 — status pill / metric cell / glyph matrix 等小组件统一消费。
export type Tone = 'neutral' | 'warning' | 'accent' | 'success' | 'muted'

// 深度复核弹窗的入参 — 当前选中的照片 + 它所在的连拍组(可能为空)。
export type ReviewDetail = {
  photo: PhotoRecord
  group: PhotoGroupRecord | null
}

// 单文件夹的统计汇总 — 选片头部 metric strip / inspector / 导出预检 / archive
// 数据派生(scanner/SSE 实时更新)统一消费。
export type FolderSummary = {
  newSpeciesCount: number
  birdPhotoCount: number
  noBirdCount: number
  failedCount: number
  speciesCount: number
  gradeCounts: Record<PhotoGrade, number>
}

export function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return '--'
  return (score * 100).toFixed(1)
}

// 用户人工评级覆盖模型评级 — 选片/复核/羽迹各处展示统一走这个。
export function effectivePhotoGrade(photo: PhotoRecord): PhotoGrade {
  return photo.decision ?? photo.grade
}

export function effectiveSpeciesName(photo: PhotoRecord): string | null {
  if (photo.manualSpecies || photo.speciesSource === 'manual') return photo.speciesName
  if (photo.speciesSource === 'group_consensus') return photo.groupSpeciesName ?? photo.speciesName
  if (photo.speciesSource === 'model') return photo.modelSpeciesName ?? photo.speciesName
  // model_unconfirmed: 仍展示模型识别物种（但 UI 会带"待审"徽标）
  if (photo.speciesSource === 'model_unconfirmed') return photo.speciesName
  return photo.speciesName
}

export function effectiveSpeciesLatinName(photo: PhotoRecord): string | null {
  if (photo.manualSpecies || photo.speciesSource === 'manual') return photo.speciesLatinName
  if (photo.speciesSource === 'group_consensus') {
    return photo.groupSpeciesLatinName ?? photo.speciesLatinName
  }
  if (photo.speciesSource === 'model') return photo.modelSpeciesLatinName ?? photo.speciesLatinName
  // model_unconfirmed: 仍展示模型识别拉丁名（带"待审"徽标）
  if (photo.speciesSource === 'model_unconfirmed') return photo.speciesLatinName
  return photo.speciesLatinName
}

// 老库的 best_af_point 没有结构化 area,前端补一个最小 AfOverlay 让覆盖层组件
// 不用分支两套数据形态。
export function legacyAfPointToOverlay(point: { x: number; y: number } | null): AfOverlay | null {
  if (!point) return null
  return {
    kind: 'point',
    source: 'legacy',
    center: point,
    points: [{ ...point, in_focus: true, selected: true }],
    focused_points: [{ ...point, in_focus: true, selected: true }],
    selected_points: [{ ...point, in_focus: true, selected: true }],
    focused_count: 1,
    selected_count: 1,
    point_count: 1,
  }
}
