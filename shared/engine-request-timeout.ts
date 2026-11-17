/** Initial RAW hashing/scanning can exceed a minute for a large photo folder. */
export function engineRequestTimeout(path: string): number {
  const route = path.split('?')[0]
  return route === '/analysis/batch' ||
    route === '/library/import' ||
    /^\/library\/[^/]+\/update$/.test(route)
    ? 30 * 60_000
    : 60_000
}
