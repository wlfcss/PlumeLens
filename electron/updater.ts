/**
 * GitHub Release update checker for Electron main process.
 */

import { app, net } from 'electron'
import type { UpdateCheckResult } from '../shared/ipc'

export const GITHUB_REPO = 'wlfcss/PlumeLens'
export const GITHUB_REPO_PATH = `/${GITHUB_REPO.toLowerCase()}`
const GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

function parseVersion(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const parsed = Number.parseInt(part, 10)
      return Number.isFinite(parsed) ? parsed : 0
    })
}

export function compareVersions(a: string, b: string): number {
  const av = parseVersion(a)
  const bv = parseVersion(b)
  for (let i = 0; i < Math.max(av.length, bv.length, 3); i += 1) {
    const left = av[i] ?? 0
    const right = bv[i] ?? 0
    if (left > right) return 1
    if (left < right) return -1
  }
  return 0
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  try {
    const response = await net.fetch(GITHUB_LATEST_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `PlumeLens/${currentVersion}`,
      },
    })
    if (!response.ok) {
      const remaining = response.headers.get('x-ratelimit-remaining')
      if ((response.status === 403 || response.status === 429) && remaining === '0') {
        const resetEpoch = Number(response.headers.get('x-ratelimit-reset') ?? '')
        return {
          ok: false,
          currentVersion,
          reason: 'rate_limited',
          message: Number.isFinite(resetEpoch) && resetEpoch > 0 ? String(resetEpoch * 1000) : '',
        }
      }
      if (response.status === 404) {
        return {
          ok: false,
          currentVersion,
          reason: 'not_found',
          message: `${response.status} ${response.statusText}`,
        }
      }
      return {
        ok: false,
        currentVersion,
        reason: 'network',
        message: `${response.status} ${response.statusText}`,
      }
    }
    const payload = (await response.json()) as Record<string, unknown>
    const tagName = payload['tag_name']
    const htmlUrl = payload['html_url']
    if (typeof tagName !== 'string' || typeof htmlUrl !== 'string') {
      return {
        ok: false,
        currentVersion,
        reason: 'invalid_response',
        message: 'GitHub release response missing tag_name/html_url',
      }
    }
    return {
      ok: true,
      currentVersion,
      latestVersion: tagName.replace(/^v/i, ''),
      hasUpdate: compareVersions(tagName, currentVersion) > 0,
      releaseUrl: htmlUrl,
      releaseName: typeof payload['name'] === 'string' ? payload['name'] : null,
      publishedAt: typeof payload['published_at'] === 'string' ? payload['published_at'] : null,
    }
  } catch (err) {
    return {
      ok: false,
      currentVersion,
      reason: 'network',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
