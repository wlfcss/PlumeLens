/** Windows may still be initializing the frozen runtime and models after one minute. */
export function engineStartupTimeout(platform?: string): number {
  return platform === 'win32' ? 180_000 : 90_000
}

/** Initial RAW hashing/scanning can exceed a minute for a large photo folder. */
export function engineRequestTimeout(path: string): number {
  const route = path.split('?')[0]
  return route === '/analysis/batch' ||
    route === '/library/import' ||
    /^\/library\/[^/]+\/update$/.test(route)
    ? 30 * 60_000
    : 60_000
}
