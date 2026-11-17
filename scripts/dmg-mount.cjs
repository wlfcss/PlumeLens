/** Task-owned disk image mounts. Never infer ownership from a volume name. */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
// Already supplied by electron-builder/app-builder-lib; no new dependency.
const { parse } = require('plist')

function canonical(file) {
  try {
    return fs.realpathSync(file)
  } catch {
    const absolute = path.resolve(file)
    try {
      return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute))
    } catch {
      return absolute
    }
  }
}

function diskDevice(entity) {
  return entity['dev-entry']?.match(/^\/dev\/disk\d+(?=s\d|$)/)?.[0]
}

function createDmgMount(imagePath, mountPoint, options = {}) {
  const run = options.run ?? execFileSync
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const warn = options.warn ?? console.warn
  const delays = options.delays ?? [250, 750, 1500, 3000, 5000]
  const image = canonical(imagePath)
  const mount = canonical(mountPoint)
  let device = null

  function plistCommand(args) {
    return parse(run('hdiutil', args, { encoding: 'utf8' }).toString())
  }

  function attachedImage() {
    const info = plistCommand(['info', '-plist'])
    if (!Array.isArray(info.images)) throw new Error('hdiutil info: images array missing')
    const images = info.images
    const entities = (item) => item['system-entities'] ?? []
    const owned = images.filter((item) => canonical(item['image-path'] ?? '') === image)
    if (device) {
      const reused = images.find(
        (item) =>
          canonical(item['image-path'] ?? '') !== image &&
          entities(item).some((entity) => diskDevice(entity) === device),
      )
      if (reused)
        throw new Error(`Refusing to detach reused device ${device}: image identity changed`)
    }
    const candidates = owned.filter((item) =>
      entities(item).some((entity) =>
        device
          ? diskDevice(entity) === device
          : entity['mount-point'] && canonical(entity['mount-point']) === mount,
      ),
    )
    if (candidates.length > 1) throw new Error(`Ambiguous disk image attachment: ${image}`)
    if (candidates.length === 0) {
      if (
        owned.length ||
        images.some((item) =>
          entities(item).some(
            (entity) => entity['mount-point'] && canonical(entity['mount-point']) === mount,
          ),
        )
      ) {
        throw new Error(`Attachment identity changed; preserving ${image} and ${mount}`)
      }
      return null
    }
    const entry = candidates[0]
    if (
      entities(entry).some(
        (entity) => entity['mount-point'] && canonical(entity['mount-point']) !== mount,
      )
    ) {
      throw new Error(`Unexpected mount point for ${image}; refusing to detach`)
    }
    device ??= diskDevice(
      entities(entry).find((entity) => entity['mount-point']) ?? entities(entry)[0] ?? {},
    )
    if (!device) throw new Error(`hdiutil info: cannot identify device for ${image}`)
    return entry
  }

  return {
    mountPoint: mount,
    attach(readOnly = false) {
      fs.mkdirSync(mount, { recursive: true })
      const attached = plistCommand([
        'attach',
        image,
        '-plist',
        '-mountpoint',
        mount,
        '-nobrowse',
        '-noautoopen',
        readOnly ? '-readonly' : '-readwrite',
      ])
      const mounted = attached['system-entities']?.find(
        (entity) => entity['mount-point'] && canonical(entity['mount-point']) === mount,
      )
      device = mounted && diskDevice(mounted)
      if (!device) throw new Error(`hdiutil attach: cannot identify task mount ${mount}`)
      if (!attachedImage()) throw new Error(`hdiutil attach: ${image} is not attached`)
      return mount
    },
    assertDetached() {
      if (attachedImage()) throw new Error(`Disk image still attached: ${image} (${device})`)
    },
    async detach() {
      let lastError
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        if (!attachedImage()) return // Also handles a failed attach that never mounted.
        const args = ['detach', device]
        if (attempt >= 3) args.push('-force')
        try {
          const output = run('hdiutil', args, { encoding: 'utf8' })
          if (output?.toString().trim()) console.log(output.toString().trim())
        } catch (error) {
          lastError = error
          // -quiet suppresses stderr too, so intentionally never use it here.
          warn(
            `[build-dmg] detach ${device} attempt ${attempt + 1} failed: ` +
              `${error.stderr?.toString().trim() || error.message}`,
          )
        }
        if (!attachedImage()) return
        if (attempt < delays.length) await wait(delays[attempt])
      }
      throw new Error(
        `Unable to detach task image ${image} (${device}); preserving mounted files`,
        {
          cause: lastError,
        },
      )
    },
  }
}

function cleanupDmgWorkspace(workspace, mounts, remove = fs.rmSync) {
  for (const mount of mounts) mount.assertDetached()
  remove(workspace, { recursive: true, force: true })
}

module.exports = { createDmgMount, cleanupDmgWorkspace }
