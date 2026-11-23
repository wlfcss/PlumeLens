/**
 * 面向 Lightroom 等后期工作流的命名导出预设。
 *
 * 内置三套常用预设（标准导入 / 精选精修 / 仅同步 XMP 边车），并允许用户在本地
 * 保存或删除自定义命名预设。不修改原片目录，全部复用现有导出快照与恢复链路。
 */
import type { ExportContentMode, ExportLayout } from '@/components/export-drawer'
import type { PhotoGrade } from '@/lib/workspace-types'

export interface ExportPreset {
  id: string
  name: string
  builtin: boolean
  grades: PhotoGrade[]
  layout: ExportLayout
  contentMode: ExportContentMode
  minScore: string
  maxScore: string
}

const STORAGE_KEY = 'plumelens.export.presets.v1'
const MAX_CUSTOM_PRESETS = 20
const MAX_PRESET_NAME_LENGTH = 60
const VALID_GRADES = new Set<PhotoGrade>(['select', 'usable', 'record', 'reject'])
const VALID_LAYOUTS = new Set<ExportLayout>(['merged', 'by_grade'])
const VALID_CONTENT_MODES = new Set<ExportContentMode>(['files', 'files_xmp', 'xmp_only'])

export const BUILTIN_EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    id: 'builtin:lr-standard',
    name: 'export.presets.lrStandard',
    builtin: true,
    grades: ['select', 'usable', 'record'],
    layout: 'merged',
    contentMode: 'files_xmp',
    minScore: '',
    maxScore: '',
  },
  {
    id: 'builtin:lr-selects',
    name: 'export.presets.lrSelects',
    builtin: true,
    grades: ['select'],
    layout: 'by_grade',
    contentMode: 'files_xmp',
    minScore: '',
    maxScore: '',
  },
  {
    id: 'builtin:lr-xmp-only',
    name: 'export.presets.lrXmpOnly',
    builtin: true,
    grades: ['select', 'usable', 'record'],
    layout: 'merged',
    contentMode: 'xmp_only',
    minScore: '',
    maxScore: '',
  },
]

function sanitizePreset(raw: unknown): ExportPreset | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const name =
    typeof record.name === 'string' ? record.name.trim().slice(0, MAX_PRESET_NAME_LENGTH) : ''
  if (!id || !name || id.startsWith('builtin:')) return null
  const grades = Array.isArray(record.grades)
    ? record.grades.filter(
        (grade): grade is PhotoGrade =>
          typeof grade === 'string' && VALID_GRADES.has(grade as PhotoGrade),
      )
    : []
  if (grades.length === 0) return null
  const layout = VALID_LAYOUTS.has(record.layout as ExportLayout)
    ? (record.layout as ExportLayout)
    : 'merged'
  const contentMode = VALID_CONTENT_MODES.has(record.contentMode as ExportContentMode)
    ? (record.contentMode as ExportContentMode)
    : 'files_xmp'
  const minScore = typeof record.minScore === 'string' ? record.minScore : ''
  const maxScore = typeof record.maxScore === 'string' ? record.maxScore : ''
  return {
    id,
    name,
    builtin: false,
    grades: Array.from(new Set(grades)),
    layout,
    contentMode,
    minScore,
    maxScore,
  }
}

export function loadCustomExportPresets(): ExportPreset[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return []
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(sanitizePreset).filter((item): item is ExportPreset => item !== null)
  } catch {
    return []
  }
}

export function saveCustomExportPresets(presets: ExportPreset[]): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    const clean = presets.filter((item) => !item.builtin).slice(-MAX_CUSTOM_PRESETS)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean))
  } catch {
    // 忽略受限环境或配额错误
  }
}

export function matchesExportPreset(
  preset: ExportPreset,
  state: {
    grades: PhotoGrade[]
    layout: ExportLayout
    contentMode: ExportContentMode
    minScore: string
    maxScore: string
  },
): boolean {
  if (preset.layout !== state.layout) return false
  if (preset.contentMode !== state.contentMode) return false
  if (preset.minScore.trim() !== state.minScore.trim()) return false
  if (preset.maxScore.trim() !== state.maxScore.trim()) return false
  if (preset.grades.length !== state.grades.length) return false
  const set = new Set(state.grades)
  return preset.grades.every((grade) => set.has(grade))
}
