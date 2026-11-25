/**
 * Shared atomic file writer for Electron main-process JSON/text persistence.
 *
 * Writes to a PID+counter-scoped sibling temp file with `0o600` permissions
 * and atomically renames into place to prevent torn JSON on crash or power loss.
 */

import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

let tmpCounter = 0

export function writeTextAtomicSync(targetPath: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(targetPath), { recursive: true })
  tmpCounter = (tmpCounter + 1) % 1_000_000
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.${tmpCounter}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf-8', mode })
  renameSync(tmp, targetPath)
}

export function writeJsonAtomicSync(targetPath: string, payload: unknown, mode = 0o600): void {
  writeTextAtomicSync(targetPath, JSON.stringify(payload, null, 2), mode)
}
