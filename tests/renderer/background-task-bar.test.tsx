import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import {
  BackgroundTaskBar,
  resolveBackgroundTaskbar,
} from '@/components/common/background-task-bar'
import type { AnalysisProgressEvent } from '@/lib/api-client'
import type { FolderRecord, FolderStatus } from '@/lib/workspace-types'

const t = i18n.getFixedT('zh-CN')

function makeFolder(status: FolderStatus, analyzedCount = 3, totalCount = 10): FolderRecord {
  return {
    id: 'lib-1',
    displayName: '测试库',
    parentPath: '/tmp',
    rootPath: '/tmp/lib-1',
    status,
    totalCount,
    analyzedCount,
    recursive: true,
    lastOpenedAt: '2026-11-22T09:00:00Z',
    lastScannedAt: null,
    lastAnalyzedAt: null,
  }
}

afterEach(() => {
  cleanup()
})

describe('BackgroundTaskBar per-phase progress', () => {
  it('never displays analyzed ratio during scanning, hashing, updating, or exporting', () => {
    for (const status of ['scanning', 'hashing', 'updating', 'exporting'] as const) {
      const folder = makeFolder(status, 3, 10)
      const view = render(<BackgroundTaskBar activeFolder={folder} t={t} />)
      expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
      expect(view.container.textContent).not.toContain('3/10')
      cleanup()
    }
  })

  it('shows indeterminate progress when scanning total is unknown', () => {
    const folder = makeFolder('scanning', 0, 0)
    render(<BackgroundTaskBar activeFolder={folder} t={t} />)
    expect(screen.getByText('正在扫描')).toBeVisible()
    expect(screen.getByText('进行中…')).toBeVisible()
  })

  it('uses SSE run totals and failure counts during analysis and distinguishes pause/stop', () => {
    const folder = makeFolder('analyzing_partial', 2, 100)
    const runningEvent: AnalysisProgressEvent = {
      library_id: 'lib-1',
      desired_state: 'running',
      completed: 7,
      total: 10,
      pending: 1,
      processing: 1,
      failed: 1,
      dead: 0,
      current_photo_id: 'p9',
    }
    const { rerender } = render(
      <BackgroundTaskBar activeFolder={folder} progressEvent={runningEvent} t={t} />,
    )
    expect(screen.getByText('分析进行中')).toBeVisible()
    expect(screen.getByText('8/10 · 失败 1')).toBeVisible()

    rerender(
      <BackgroundTaskBar
        activeFolder={makeFolder('ready', 8, 100)}
        progressEvent={{ ...runningEvent, desired_state: 'paused', processing: 0 }}
        t={t}
      />,
    )
    expect(screen.getByText('分析已暂停')).toBeVisible()
    expect(screen.getByText('8/10 · 失败 1')).toBeVisible()

    rerender(
      <BackgroundTaskBar
        activeFolder={makeFolder('ready', 8, 100)}
        progressEvent={{ ...runningEvent, desired_state: 'cancelled', pending: 0, processing: 1 }}
        t={t}
      />,
    )
    expect(screen.getByText('正在停止分析…')).toBeVisible()

    expect(
      resolveBackgroundTaskbar(
        makeFolder('ready', 10, 10),
        { ...runningEvent, desired_state: 'cancelled', pending: 0, processing: 0 },
        false,
        t,
      ),
    ).toBeNull()
  })
})
