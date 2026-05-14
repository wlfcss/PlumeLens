/**
 * Tone & label-key 纯派生函数回归 — 把每个 input → Tone / string 的映射锁死。
 *
 * 为什么需要这测试:T2 大刀 refactor 期间发现 statusTone 漏写 'ready' → 'success'
 * 一行(commit f9e2d2b 修复),但 typecheck/原有 vitest 都没抓到 — 这类纯派生
 * 函数的回归只能通过显式 map 测试锁。
 */
import { describe, expect, it } from 'vitest'

import { categoryTone, gradeTone, statusTone, type PhotoCategory } from '@/lib/photo-display'
import { analysisTone, decisionTone, categoryLabelKey } from '@/lib/photo-grid-helpers'
import {
  archiveTabLabelKey,
  gradeLabelKey,
  poseTagKey,
  problemTagKey,
  routeLabelKey,
  statusLabelKey,
} from '@/lib/i18n-keys'
import type {
  AnalysisStatus,
  AppRoute,
  ArchiveTab,
  FolderStatus,
  PhotoGrade,
  PoseTagId,
  ProblemTagId,
  SelectionDecision,
} from '@/lib/workspace-types'

describe('tone helpers', () => {
  it('gradeTone — 4 档分级 → 4 个 tone', () => {
    const map: Record<PhotoGrade, string> = {
      select: 'success',
      usable: 'neutral',
      record: 'warning',
      reject: 'accent',
    }
    for (const [grade, expected] of Object.entries(map)) {
      expect(gradeTone(grade as PhotoGrade)).toBe(expected)
    }
  })

  it('categoryTone — no_bird 单独 muted, 其余继承 gradeTone', () => {
    expect(categoryTone('no_bird')).toBe('muted')
    expect(categoryTone('select')).toBe('success')
    expect(categoryTone('usable')).toBe('neutral')
    expect(categoryTone('record')).toBe('warning')
    expect(categoryTone('reject')).toBe('accent')
  })

  it('statusTone — 9 个 folder status 全覆盖(防止 ready→success 漏写回归)', () => {
    const map: Record<FolderStatus, string> = {
      idle: 'neutral',
      ready: 'success',
      path_missing: 'accent',
      error: 'accent',
      analyzing_partial: 'warning',
      scanning: 'warning',
      hashing: 'warning',
      updating: 'neutral',
      exporting: 'neutral',
    }
    for (const [status, expected] of Object.entries(map)) {
      expect(statusTone(status as FolderStatus)).toBe(expected)
    }
  })

  it('analysisTone — 4 个分析状态映射', () => {
    const map: Record<AnalysisStatus, string> = {
      done: 'success',
      running: 'warning',
      failed: 'accent',
      pending: 'neutral',
    }
    for (const [status, expected] of Object.entries(map)) {
      expect(analysisTone(status as AnalysisStatus)).toBe(expected)
    }
  })

  it('decisionTone — null fallback + 4 档', () => {
    const map: Record<string, string> = {
      select: 'success',
      usable: 'success',
      record: 'warning',
      reject: 'accent',
    }
    for (const [d, expected] of Object.entries(map)) {
      expect(decisionTone(d as SelectionDecision)).toBe(expected)
    }
    expect(decisionTone(null)).toBe('muted')
  })
})

describe('i18n key generators', () => {
  it('gradeLabelKey — 4 档', () => {
    const grades: PhotoGrade[] = ['select', 'usable', 'record', 'reject']
    for (const g of grades) {
      expect(gradeLabelKey(g)).toBe(`selection.grade.${g}`)
    }
  })

  it('categoryLabelKey — no_bird 走专属 key', () => {
    expect(categoryLabelKey('no_bird' as PhotoCategory)).toBe('selection.quickFilters.no_bird')
    expect(categoryLabelKey('select' as PhotoCategory)).toBe('selection.grade.select')
    expect(categoryLabelKey('reject' as PhotoCategory)).toBe('selection.grade.reject')
  })

  it('statusLabelKey — 9 个 folder status', () => {
    const statuses: FolderStatus[] = [
      'idle',
      'ready',
      'path_missing',
      'error',
      'analyzing_partial',
      'scanning',
      'hashing',
      'updating',
      'exporting',
    ]
    for (const s of statuses) {
      expect(statusLabelKey(s)).toBe(`selection.folderStatus.${s}`)
    }
  })

  it('archiveTabLabelKey / routeLabelKey / poseTagKey / problemTagKey', () => {
    const tabs: ArchiveTab[] = ['species', 'map']
    for (const t of tabs) expect(archiveTabLabelKey(t)).toBe(`archive.tabs.${t}`)
    const routes: AppRoute[] = ['start', 'selection', 'archive']
    for (const r of routes) expect(routeLabelKey(r)).toBe(`nav.${r}`)
    const poses: PoseTagId[] = ['eye_visible', 'head_clean', 'wings_open', 'perched', 'multi_bird']
    for (const p of poses) expect(poseTagKey(p)).toBe(`selection.poseTags.${p}`)
    const problems: ProblemTagId[] = [
      'no_bird',
      'subject_small',
      'eye_soft',
      'head_occluded',
      'wing_cropped',
      'low_species_confidence',
    ]
    for (const p of problems) expect(problemTagKey(p)).toBe(`selection.problemTags.${p}`)
  })
})
