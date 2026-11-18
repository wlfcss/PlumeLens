import path from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'

/** Create a fresh cache before canonicalizing aliased Windows/profile paths. */
export async function prepareCacheDirectory(root: string): Promise<string> {
  await mkdir(root, { recursive: true })
  return await realpath(root)
}

/** Containment with the host's drive, case and separator semantics. */
export function isWithinDirectory(
  root: string,
  candidate: string,
  paths: Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'> = path,
): boolean {
  const relative = paths.relative(root, candidate)
  return (
    relative === '' ||
    (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`))
  )
}
