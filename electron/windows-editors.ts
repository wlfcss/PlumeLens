import { existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** Discover common installations, including custom Photoshop App Paths. */
export function findWindowsEditor(
  tool: 'topaz' | 'photoshop',
  roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
    (root): root is string => Boolean(root),
  ),
): string | null {
  const candidates: string[] = []
  for (const root of roots) {
    if (tool === 'photoshop') {
      const adobe = join(root, 'Adobe')
      try {
        const versions = readdirSync(adobe)
          .filter((name) => name.startsWith('Adobe Photoshop'))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        candidates.push(...versions.map((name) => join(adobe, name, 'Photoshop.exe')))
      } catch {
        /* Adobe is not installed at this root. */
      }
    } else {
      for (const name of [
        'Topaz Photo',
        'Topaz Photo AI',
        'Topaz Sharpen AI',
        'Topaz DeNoise AI',
        'Topaz Gigapixel',
        'Topaz Gigapixel AI',
      ]) {
        candidates.push(join(root, 'Topaz Labs LLC', name, `${name}.exe`))
      }
    }
  }
  const installed = candidates.find(existsSync)
  if (installed) return installed
  if (tool === 'photoshop') {
    const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
    for (const hive of ['HKCU', 'HKLM']) {
      try {
        const result = execFileSync(
          reg,
          [
            'query',
            `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe`,
            '/ve',
          ],
          {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 2_000,
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        )
        const path = result
          .match(/REG_SZ\s+(.+)/)?.[1]
          ?.trim()
          .replace(/^"|"$/g, '')
        if (path && existsSync(path)) return path
      } catch {
        /* No registered installation in this hive. */
      }
    }
  }
  return null
}
