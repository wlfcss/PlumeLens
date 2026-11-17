// @vitest-environment node
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const load = createRequire(import.meta.url)
const { build } = load('plist')
const { createDmgMount, cleanupDmgWorkspace } = load('../../scripts/dmg-mount.cjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plumelens-mount-test-')))
  roots.push(root)
  const image = join(root, 'image.rw.dmg')
  const mountPoint = join(root, 'mount')
  let attached = false
  let busy = 0
  let falseSuccess = false
  let detachThenThrow = false
  let changedImage = image
  let changedMount = mountPoint
  let failInfo = false
  const unrelated = {
    'image-path': '/tmp/user-opened.dmg',
    'system-entities': [{ 'dev-entry': '/dev/disk99s2', 'mount-point': '/Volumes/鉴翎 0.7.7' }],
  }
  const entity = () => ({ 'dev-entry': '/dev/disk42s2', 'mount-point': changedMount })
  const run = vi.fn((_command: string, args: string[]) => {
    if (args[0] === 'attach') {
      attached = true
      return build({ 'system-entities': [entity()] })
    }
    if (args[0] === 'info') {
      if (failInfo) throw new Error('hdiutil info unavailable')
      return build({
        images: [
          unrelated,
          ...(attached ? [{ 'image-path': changedImage, 'system-entities': [entity()] }] : []),
        ],
      })
    }
    if (args[0] === 'detach') {
      if (detachThenThrow) attached = false
      if (busy-- > 0 || detachThenThrow) {
        const error = new Error('hdiutil detach failed') as Error & { stderr: Buffer }
        error.stderr = Buffer.from('Resource busy: indexing process still holds the volume')
        throw error
      }
      if (!falseSuccess) attached = false
      return ''
    }
    throw new Error(`Unexpected command: ${args[0]}`)
  })
  const wait = vi.fn().mockResolvedValue(undefined)
  const warn = vi.fn()
  const lease = createDmgMount(image, mountPoint, { run, wait, warn, delays: [1, 2, 3, 4] })
  const detaches = () => run.mock.calls.filter(([, args]) => args[0] === 'detach')
  return {
    root,
    mountPoint,
    lease,
    run,
    wait,
    warn,
    detaches,
    setBusy: (count: number) => (busy = count),
    setAttached: (value: boolean) => (attached = value),
    setFalseSuccess: () => (falseSuccess = true),
    setDetachThenThrow: () => (detachThenThrow = true),
    setChangedImage: () => (changedImage = '/tmp/another-users-image.dmg'),
    setChangedMount: () => (changedMount = '/Volumes/unrelated'),
    setFailInfo: () => (failInfo = true),
  }
}

describe('task-owned DMG mounts', () => {
  it('attaches at the task mount point and retries busy whole-device detach with stderr', async () => {
    const f = fixture()
    f.lease.attach()
    const attachArgs = f.run.mock.calls[0][1]
    expect(attachArgs).toEqual([
      'attach',
      join(f.root, 'image.rw.dmg'),
      '-plist',
      '-mountpoint',
      f.mountPoint,
      '-nobrowse',
      '-noautoopen',
      '-readwrite',
    ])
    f.setBusy(2)
    await f.lease.detach()
    expect(f.detaches().map(([, args]) => args)).toEqual([
      ['detach', '/dev/disk42'],
      ['detach', '/dev/disk42'],
      ['detach', '/dev/disk42'],
    ])
    expect(f.wait.mock.calls).toEqual([[1], [2]])
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('Resource busy: indexing process'))
    f.lease.assertDetached()
  })

  it('treats an already detached image as success without touching unrelated same-name volumes', async () => {
    const f = fixture()
    f.lease.attach(true)
    f.setAttached(false)
    await f.lease.detach()
    await f.lease.detach()
    expect(f.detaches()).toEqual([])
    const remove = vi.fn()
    cleanupDmgWorkspace(f.root, [f.lease], remove)
    expect(remove).toHaveBeenCalledWith(f.root, { recursive: true, force: true })
  })

  it('accepts a detach error only when inventory confirms that the image disappeared', async () => {
    const f = fixture()
    f.lease.attach()
    f.setDetachThenThrow()
    await f.lease.detach()
    expect(f.detaches()).toHaveLength(1)
    f.lease.assertDetached()
  })

  it('uses force only for its own verified device and preserves persistently busy files', async () => {
    const f = fixture()
    f.lease.attach()
    f.setBusy(100)
    await expect(f.lease.detach()).rejects.toThrow('Unable to detach task image')
    expect(f.detaches().map(([, args]) => args)).toEqual([
      ['detach', '/dev/disk42'],
      ['detach', '/dev/disk42'],
      ['detach', '/dev/disk42'],
      ['detach', '/dev/disk42', '-force'],
      ['detach', '/dev/disk42', '-force'],
    ])
    const remove = vi.fn()
    expect(() => cleanupDmgWorkspace(f.root, [f.lease], remove)).toThrow('still attached')
    expect(remove).not.toHaveBeenCalled()
  })

  it('does not trust exit zero while the image remains attached', async () => {
    const f = fixture()
    f.lease.attach()
    f.setFalseSuccess()
    await expect(f.lease.detach()).rejects.toThrow('Unable to detach task image')
    expect(() => f.lease.assertDetached()).toThrow('still attached')
  })

  it('refuses a reused device rather than ejecting another image', async () => {
    const f = fixture()
    f.lease.attach()
    f.setChangedImage()
    await expect(f.lease.detach()).rejects.toThrow('Refusing to detach reused device')
    expect(f.detaches()).toEqual([])
  })

  it('refuses an unexpected mount point rather than following a moved mount', async () => {
    const f = fixture()
    f.lease.attach()
    f.setChangedMount()
    await expect(f.lease.detach()).rejects.toThrow('Unexpected mount point')
    expect(f.detaches()).toEqual([])
  })

  it('fails closed if attachment inventory cannot be read', async () => {
    const f = fixture()
    f.lease.attach()
    f.setFailInfo()
    await expect(f.lease.detach()).rejects.toThrow('hdiutil info unavailable')
    const remove = vi.fn()
    expect(() => cleanupDmgWorkspace(f.root, [f.lease], remove)).toThrow('hdiutil info unavailable')
    expect(remove).not.toHaveBeenCalled()
    expect(f.detaches()).toEqual([])
  })

  it('normalizes a symlink parent before the image and mount point exist', async () => {
    const f = fixture()
    const real = join(f.root, 'real')
    const alias = join(f.root, 'alias')
    mkdirSync(real)
    symlinkSync(real, alias)
    const entity = { 'dev-entry': '/dev/disk42s2', 'mount-point': join(real, 'mount') }
    let attached = false
    const run = vi.fn((_command: string, args: string[]) => {
      if (args[0] === 'attach') {
        attached = true
        return build({ 'system-entities': [entity] })
      }
      if (args[0] === 'info') {
        return build({
          images: attached
            ? [{ 'image-path': join(real, 'image.dmg'), 'system-entities': [entity] }]
            : [],
        })
      }
      attached = false
      return ''
    })
    const lease = createDmgMount(join(alias, 'image.dmg'), join(alias, 'mount'), { run })
    expect(lease.attach()).toBe(join(real, 'mount'))
    expect(run.mock.calls[0][1][1]).toBe(join(real, 'image.dmg'))
    await lease.detach()
  })

  it.each(['output', 'readwrite'] as const)(
    'never converts, publishes or deletes an image when %s remains attached',
    async (blocked) => {
      const run = vi.fn()
      const remove = vi.fn()
      const rename = vi.fn()
      const createMount = vi.fn((image: string, mount: string) => {
        let attached = false
        return {
          attach: () => {
            attached = true
            return mount
          },
          detach: async () => {
            if (blocked === 'readwrite' && image.endsWith('image.rw.dmg')) {
              throw new Error('Task readwrite image is still mounted')
            }
            attached = false
          },
          assertDetached: () => {
            if (
              attached ||
              (blocked === 'output' && image === '/release/PlumeLens-0.7.7-arm64.dmg')
            ) {
              throw new Error('Image is still mounted')
            }
          },
        }
      })
      const module = {
        exports: {} as { default: (context: { outDir: string }) => Promise<string[]> },
      }
      runInNewContext(
        readFileSync(new URL('../../scripts/build-dmg.cjs', import.meta.url), 'utf8'),
        {
          module,
          exports: module.exports,
          __dirname: '/repo/scripts',
          process: { arch: 'arm64', env: { CUSTOM_DMGBUILD_PATH: '/tools/dmgbuild' } },
          console: { log: vi.fn(), error: vi.fn() },
          require: (name: string) => {
            if (name === 'child_process') return { execFileSync: run }
            if (name === 'app-builder-lib/out/binDownload') return {}
            if (name === 'path') return load('node:path')
            if (name === './dmg-mount.cjs') {
              return {
                createDmgMount: createMount,
                cleanupDmgWorkspace: (root: string, mounts: unknown[]) =>
                  cleanupDmgWorkspace(root, mounts, remove),
              }
            }
            if (name === 'fs') {
              return {
                existsSync: () => true,
                readFileSync: () => '{"version":"0.7.7"}',
                mkdtempSync: () => '/release/.plumelens-dmg-test',
                realpathSync: (file: string) => file,
                mkdirSync: vi.fn(),
                symlinkSync: vi.fn(),
                copyFileSync: vi.fn(),
                rmSync: remove,
                renameSync: rename,
              }
            }
            throw new Error(`Unexpected dependency ${name}`)
          },
        },
      )
      const promise = module.exports.default({ outDir: '/release' })
      await expect(promise).rejects.toThrow('still mounted')
      expect(rename).not.toHaveBeenCalled()
      expect(
        run.mock.calls.some(([command, args]) => command === 'hdiutil' && args[0] === 'convert'),
      ).toBe(false)
      if (blocked === 'output') {
        expect(run).not.toHaveBeenCalled()
        expect(remove).toHaveBeenCalledWith('/release/.plumelens-dmg-test', {
          recursive: true,
          force: true,
        })
      } else {
        expect(remove).not.toHaveBeenCalled()
      }
    },
  )
})
