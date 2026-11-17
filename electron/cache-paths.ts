import path from 'node:path'

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
