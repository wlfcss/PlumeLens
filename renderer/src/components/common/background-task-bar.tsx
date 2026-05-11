import type { useTranslation } from 'react-i18next'

import { GlyphMatrix } from '@/components/common/glyph-matrix'
import { statusLabelKey } from '@/lib/i18n-keys'
import type { FolderRecord, FolderStatus } from '@/lib/mock-workspace'
import { formatRatio } from '@/lib/photo-helpers'

// "活跃任务"指 scanner / hashing / 后台 analyzer / metadata updater / exporter
// 之一仍在跑;UI 在底部显示 GlyphMatrix 进度 + 状态文案。
function folderHasActiveTasks(status: FolderStatus): boolean {
  return ['scanning', 'hashing', 'analyzing_partial', 'updating', 'exporting'].includes(status)
}

export function BackgroundTaskBar({
  activeFolder,
  t,
}: {
  activeFolder: FolderRecord | null
  t: ReturnType<typeof useTranslation>['t']
}) {
  if (!activeFolder || !folderHasActiveTasks(activeFolder.status)) return null

  return (
    <footer className="background-taskbar">
      <span>{t(statusLabelKey(activeFolder.status))}</span>
      {/* 进度条本身用 success(绿色)而非 statusTone — 状态文案仍由
          statusLabelKey 控制(分析进行中 / 扫描中 / 哈希中),颜色语义在
          glyph-matrix 上单独表达"已经完成的进度",绿色更直观;breathing 动画
          见 app.css `.glyph-matrix .tone-success`,提示仍在运行。 */}
      <GlyphMatrix
        tone="success"
        value={Math.max(
          3,
          Math.round((activeFolder.analyzedCount / Math.max(activeFolder.totalCount, 1)) * 12),
        )}
      />
      <span>{formatRatio(activeFolder.analyzedCount, activeFolder.totalCount)}</span>
    </footer>
  )
}
