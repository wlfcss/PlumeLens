/**
 * External photo editor discovery & detached launch (Topaz Photo / Adobe Photoshop).
 */

import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { EditorListResult, EditorTool, OpenInEditorResult } from '../shared/ipc'
import { getScopedLogger } from './logger'
import { findWindowsEditor } from './windows-editors'

interface EditorEntry {
  appNames: string[]
  resolved: string | null
  appPath: string | null
}

const EDITOR_REGISTRY: Record<EditorTool, EditorEntry> = {
  topaz: {
    appNames: [
      'Topaz Photo',
      'Topaz Photo AI',
      'Topaz Sharpen AI',
      'Topaz DeNoise AI',
      'Topaz Gigapixel AI',
      'Topaz Gigapixel',
    ],
    resolved: null,
    appPath: null,
  },
  photoshop: {
    appNames: [
      'Adobe Photoshop 2026',
      'Adobe Photoshop 2025',
      'Adobe Photoshop 2024',
      'Adobe Photoshop 2023',
      'Adobe Photoshop',
    ],
    resolved: null,
    appPath: null,
  },
}

function isEditorTool(value: unknown): value is EditorTool {
  return value === 'topaz' || value === 'photoshop'
}

function parseOpenInEditorArgs(args: unknown): { tool: EditorTool; filePath: string } | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const maybeArgs = args as { tool?: unknown; path?: unknown }
  if (!isEditorTool(maybeArgs.tool)) return null
  if (typeof maybeArgs.path !== 'string') return null
  const filePath = maybeArgs.path.trim()
  if (!filePath || filePath.includes('\0')) return null
  return { tool: maybeArgs.tool, filePath }
}

function findEditorAppPath(root: string, name: string): string | null {
  const candidates = [join(root, `${name}.app`), join(root, name, `${name}.app`)]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function resolveEditors(): void {
  if (process.platform === 'win32') {
    for (const tool of Object.keys(EDITOR_REGISTRY) as EditorTool[]) {
      const entry = EDITOR_REGISTRY[tool]
      entry.appPath = findWindowsEditor(tool)
      entry.resolved = entry.appPath
        ? tool === 'photoshop'
          ? 'Adobe Photoshop'
          : 'Topaz Photo'
        : null
    }
    return
  }
  const roots = ['/Applications', join(homedir(), 'Applications')]
  for (const tool of Object.keys(EDITOR_REGISTRY) as EditorTool[]) {
    const entry = EDITOR_REGISTRY[tool]
    for (const name of entry.appNames) {
      const appPath = roots.map((root) => findEditorAppPath(root, name)).find(Boolean) ?? null
      if (appPath) {
        entry.resolved = name
        entry.appPath = appPath
        break
      }
    }
  }
  getScopedLogger('main').info('editors_detected', {
    topaz: Boolean(EDITOR_REGISTRY.topaz.resolved),
    photoshop: Boolean(EDITOR_REGISTRY.photoshop.resolved),
  })
}

export function listResolvedEditors(): EditorListResult {
  return {
    topaz: EDITOR_REGISTRY.topaz.resolved,
    photoshop: EDITOR_REGISTRY.photoshop.resolved,
  }
}

function findEditorExecutablePath(entry: EditorEntry): string | null {
  if (!entry.appPath || !entry.resolved) return null
  if (process.platform === 'win32') return entry.appPath
  const executableNames = [entry.resolved]
  try {
    const plist = readFileSync(join(entry.appPath, 'Contents', 'Info.plist'), 'utf-8')
    const match = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)
    if (match?.[1] && !executableNames.includes(match[1])) {
      executableNames.unshift(match[1])
    }
  } catch {
    /* fallback to resolved app name */
  }
  for (const name of executableNames) {
    const executablePath = join(entry.appPath, 'Contents', 'MacOS', name)
    if (existsSync(executablePath)) return executablePath
  }
  return null
}

function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    })
    let settled = false
    const settle = (callback: () => void): void => {
      if (settled) return
      settled = true
      callback()
    }
    child.once('error', (error) => {
      settle(() => rejectSpawn(error))
    })
    child.once('spawn', () => {
      child.unref()
      settle(() => resolveSpawn())
    })
  })
}

export async function openFileInEditor(args: unknown): Promise<OpenInEditorResult> {
  const parsed = parseOpenInEditorArgs(args)
  if (!parsed) {
    return { ok: false, reason: 'invalid_args' }
  }
  const { tool, filePath } = parsed
  const entry = EDITOR_REGISTRY[tool]
  if (!entry || !entry.resolved) {
    return { ok: false, reason: 'not_installed' }
  }
  let canonicalPath: string
  try {
    canonicalPath = await realpath(filePath)
    const fileStat = await stat(canonicalPath)
    if (!fileStat.isFile()) {
      return { ok: false, reason: 'file_missing' }
    }
  } catch {
    return { ok: false, reason: 'file_missing' }
  }
  try {
    if (process.platform === 'win32' && entry.appPath) {
      await spawnDetached(entry.appPath, [canonicalPath])
      return { ok: true, app: entry.resolved }
    }
    if (tool === 'topaz') {
      const executablePath = findEditorExecutablePath(entry)
      if (executablePath) {
        const topazArgs = entry.resolved.startsWith('Topaz Photo')
          ? ['--editor=PlumeLens', canonicalPath]
          : [canonicalPath]
        await spawnDetached(executablePath, topazArgs)
        return { ok: true, app: entry.resolved }
      }
    }
    const appSpecifier = entry.appPath ?? entry.resolved
    if (!appSpecifier) {
      return { ok: false, reason: 'app_missing' }
    }
    await spawnDetached('/usr/bin/open', ['-a', appSpecifier, canonicalPath])
    return { ok: true, app: entry.resolved }
  } catch (err) {
    getScopedLogger('main').warn('open_in_editor_failed', { tool }, err)
    return { ok: false, reason: 'spawn_failed' }
  }
}
