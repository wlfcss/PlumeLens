/**
 * electron-builder afterAllArtifactBuild hook：手动用 hdiutil 打 dmg。
 *
 * 不用 electron-builder 内置 dmg-builder，因为它会丢 Electron Framework binary
 * （157MB 主库），装机后 dyld 报 "Library not loaded: @rpath/Electron Framework"。
 * hdiutil + ditto 能保留所有文件（含大文件 + symlink + xattr + 代码签名）。
 *
 * 安装窗口外观:
 * 1) 先用 UDRW 创建可读写 dmg,挂上 staging 目录(.app + Applications symlink)。
 * 2) 拷 build/dmg-background.tiff 到 mount 内 .background.tiff。
 * 3) 通过 dmgbuild 随包 Python 的 ds_store/mac_alias 离线写 .DS_Store
 *    (窗口大小、背景图 alias、图标位置),不依赖 Finder/AppleScript。
 * 4) sync + detach,转 UDZO 压缩格式发布。
 *
 * 重新生成背景图: ``uv run python scripts/build_dmg_background.py``。
 * 改图标坐标记得同步 build_dmg_background.py 的 LEFT_ICON_CENTER / RIGHT_ICON_CENTER。
 */
const { execFileSync } = require('child_process')
const { downloadArtifact } = require('app-builder-lib/out/binDownload')
const fs = require('fs')
const os = require('os')
const path = require('path')

// 与 scripts/build_dmg_background.py 同步:窗口逻辑大小 640x400,图标坐标。
// electron-builder 的 contents x/y 是 1x logical points 下的图标中心坐标。
const WINDOW_W = 640
const WINDOW_H = 400
const APP_ICON_POS = { x: 180, y: 176 }
const APPLICATIONS_POS = { x: 460, y: 176 }
const ICON_SIZE = 128
const APP_NAME = 'PlumeLens.app'
const DMG_BUILDER_RELEASE = '75c8a6c'
const DMG_BUILDER_CHECKSUMS = {
  'dmgbuild-bundle-arm64-75c8a6c.tar.gz':
    'a785f2a385c8c31996a089ef8e26361904b40c772d5ea65a36001212f1fc25e0',
  'dmgbuild-bundle-x86_64-75c8a6c.tar.gz':
    '87b3bb72148b11451ee90ede79cc8d59305c9173b68b0f2b50a3bea51fc4a4e2',
}

function attachReadWrite(dmgPath) {
  const out = execFileSync('hdiutil', [
    'attach',
    dmgPath,
    '-readwrite',
    '-noverify',
    '-noautoopen',
  ]).toString()
  const m = out.match(/(\/Volumes\/[^\n]+)/)
  if (!m) throw new Error('hdiutil attach: cannot detect mount point')
  return m[1].trim()
}

function attachReadOnly(dmgPath) {
  const out = execFileSync('hdiutil', [
    'attach',
    dmgPath,
    '-nobrowse',
    '-noautoopen',
    '-readonly',
  ]).toString()
  const m = out.match(/(\/Volumes\/[^\n]+)/)
  if (!m) throw new Error('hdiutil attach: cannot detect mount point')
  return m[1].trim()
}

function detach(mountPoint) {
  // 偶发 "Resource busy" — 重试 3 次再放弃,每次 sleep 1s 让 Finder 释放。
  for (let i = 0; i < 3; i++) {
    try {
      const args =
        i === 2 ? ['detach', mountPoint, '-force', '-quiet'] : ['detach', mountPoint, '-quiet']
      execFileSync('hdiutil', args)
      return
    } catch (err) {
      if (i === 2) throw err
      execFileSync('sleep', ['1'])
    }
  }
}

/**
 * 打包前 detach 所有挂着的 "鉴翎 *" volume,避免名字冲突让 macOS 自动加数字
 * 后缀(鉴翎 0.6.0 1 / 2 / 3 ...),用户开 dmg 时 Finder 不识别 DS_Store 里的
 * layout(按 volume 名缓存),只显示默认黑底布局。
 *
 * 注意:这只清开发机器上的 stale mount,用户机器上的 mount 我们管不着;用户装
 * 新 dmg 前应该先 eject 旧的(README 应注明)。
 */
function detachStaleVolumes() {
  let mountOutput = ''
  try {
    mountOutput = execFileSync('mount').toString()
  } catch {
    return
  }
  // 匹配形如:`/dev/disk7s2 on /Volumes/鉴翎 0.6.0 (hfs, ...)`
  const lines = mountOutput.split('\n').filter((l) => l.includes('/Volumes/鉴翎'))
  for (const line of lines) {
    const m = line.match(/on (\/Volumes\/鉴翎[^(]*?) \(/)
    if (!m) continue
    const volume = m[1].trim()
    try {
      execFileSync('hdiutil', ['detach', volume, '-force', '-quiet'])
      console.log(`[build-dmg] pre-detach stale volume: ${volume}`)
    } catch (err) {
      console.warn(`[build-dmg] pre-detach failed for ${volume}:`, err.message)
    }
  }
}

async function getDmgbuildPythonPath() {
  const customDmgbuildPath = process.env.CUSTOM_DMGBUILD_PATH?.trim()
  const dmgbuildPath = customDmgbuildPath
    ? path.resolve(customDmgbuildPath)
    : path.resolve(
        await downloadArtifact({
          releaseName: 'dmg-builder@1.2.0',
          filenameWithExt: `dmgbuild-bundle-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-${DMG_BUILDER_RELEASE}.tar.gz`,
          checksums: DMG_BUILDER_CHECKSUMS,
          githubOrgRepo: 'electron-userland/electron-builder-binaries',
        }),
        'dmgbuild',
      )
  const pythonPath = path.join(path.dirname(dmgbuildPath), 'python', 'bin', 'python3')
  if (!fs.existsSync(pythonPath)) {
    throw new Error(`dmgbuild python missing: ${pythonPath}`)
  }
  return pythonPath
}

function dmgLayoutArgs(mountPoint, bgFileName, verifyOnly = false) {
  const args = [
    path.join(__dirname, 'write_dmg_dsstore.py'),
    mountPoint,
    '--background',
    bgFileName,
    '--app-name',
    APP_NAME,
    '--app-x',
    String(APP_ICON_POS.x),
    '--app-y',
    String(APP_ICON_POS.y),
    '--applications-x',
    String(APPLICATIONS_POS.x),
    '--applications-y',
    String(APPLICATIONS_POS.y),
    '--window-width',
    String(WINDOW_W),
    '--window-height',
    String(WINDOW_H),
    '--icon-size',
    String(ICON_SIZE),
    '--text-size',
    '13',
  ]
  if (verifyOnly) args.push('--verify-only')
  return args
}

function writeDmgLayout(pythonPath, mountPoint, bgFileName) {
  execFileSync(pythonPath, dmgLayoutArgs(mountPoint, bgFileName), { stdio: 'inherit' })
}

function verifyDmgLayout(pythonPath, mountPoint, bgFileName) {
  execFileSync(pythonPath, dmgLayoutArgs(mountPoint, bgFileName, true), { stdio: 'inherit' })
}

exports.default = async function (context) {
  if (!context.outDir) return
  const macDir = path.join(context.outDir, 'mac-arm64')
  const appPath = path.join(macDir, APP_NAME)
  if (!fs.existsSync(appPath)) {
    console.log(`[build-dmg] no app at ${appPath}, skip`)
    return []
  }

  const pkgVersion = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  ).version
  const dmgPath = path.join(context.outDir, `PlumeLens-${pkgVersion}-arm64.dmg`)
  const tmpDmg = path.join(context.outDir, `.PlumeLens-${pkgVersion}-arm64.rw.dmg`)
  if (fs.existsSync(dmgPath)) fs.rmSync(dmgPath)
  if (fs.existsSync(tmpDmg)) fs.rmSync(tmpDmg)

  // 防御:detach 任何挂着的同名/旧 dmg volume,避免 macOS 自动加数字后缀
  // 让 Finder 不识别新 dmg 的 DS_Store layout。
  detachStaleVolumes()

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumelens-dmg-'))
  console.log(`[build-dmg] staging in ${stagingDir}`)
  const volumeName = `鉴翎 ${pkgVersion}`
  const dmgbuildPython = await getDmgbuildPythonPath()

  // 选择背景图源 — 优先 multi-rep TIFF(retina 用 @2× rep,字体清晰),
  // tiffutil 缺失时回落到 1× PNG。提到 try 块外 — 验证步骤在 finally
  // 之后还需要引用 bgDestName。
  const bgTiff = path.join(__dirname, '..', 'build', 'dmg-background.tiff')
  const bgPng = path.join(__dirname, '..', 'build', 'dmg-background.png')
  let bgSrc, bgDestName
  if (fs.existsSync(bgTiff)) {
    bgSrc = bgTiff
    bgDestName = '.background.tiff'
  } else if (fs.existsSync(bgPng)) {
    console.log('[build-dmg] HiDPI TIFF missing, falling back to single-rep PNG')
    bgSrc = bgPng
    bgDestName = '.background.png'
  } else {
    throw new Error(
      `dmg-background.{tiff,png} missing in build/. ` +
        `Regenerate via: uv run python scripts/build_dmg_background.py`,
    )
  }

  try {
    // ditto 保留 ACL/xattr/签名
    execFileSync('ditto', [appPath, path.join(stagingDir, APP_NAME)], { stdio: 'inherit' })
    fs.symlinkSync('/Applications', path.join(stagingDir, 'Applications'))
    fs.copyFileSync(bgSrc, path.join(stagingDir, bgDestName))

    // 1) 创建可读写 UDRW dmg
    console.log(`[build-dmg] hdiutil create UDRW → ${tmpDmg}`)
    execFileSync(
      'hdiutil',
      [
        'create',
        '-volname',
        volumeName,
        '-srcfolder',
        stagingDir,
        '-fs',
        'HFS+',
        '-format',
        'UDRW',
        '-ov',
        tmpDmg,
      ],
      { stdio: 'inherit' },
    )

    // 2) 挂载,离线写 .DS_Store 设布局
    const mountPoint = attachReadWrite(tmpDmg)
    try {
      console.log(`[build-dmg] writing Finder layout at ${mountPoint}`)
      writeDmgLayout(dmgbuildPython, mountPoint, bgDestName)
      // sync 确保 .DS_Store 落盘后再 detach,否则窗口配置丢失
      execFileSync('sync')
    } finally {
      detach(mountPoint)
    }

    // 3) 转换为压缩 UDZO 发布版
    console.log(`[build-dmg] hdiutil convert → ${dmgPath}`)
    execFileSync(
      'hdiutil',
      ['convert', tmpDmg, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', dmgPath],
      { stdio: 'inherit' },
    )
  } finally {
    if (fs.existsSync(tmpDmg)) fs.rmSync(tmpDmg)
    fs.rmSync(stagingDir, { recursive: true, force: true })
  }

  // 验证 dmg 内 Framework binary 真的在
  console.log(`[build-dmg] verifying dmg contents...`)
  const verifyMount = attachReadOnly(dmgPath)
  try {
    const fwBin = path.join(
      verifyMount,
      APP_NAME,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Electron Framework',
    )
    if (!fs.existsSync(fwBin)) {
      throw new Error(`Electron Framework binary missing in dmg: ${fwBin}`)
    }
    const size = fs.statSync(fwBin).size
    if (size < 100 * 1024 * 1024) {
      throw new Error(`Electron Framework binary too small (${size}), likely corrupt`)
    }
    // 验证整个 .app 签名仍有效
    execFileSync('codesign', ['--verify', '--deep', '--strict', path.join(verifyMount, APP_NAME)], {
      stdio: 'inherit',
    })
    // 验证背景图也在 dmg 里
    const bgInDmg = path.join(verifyMount, bgDestName)
    if (!fs.existsSync(bgInDmg)) {
      throw new Error(`DMG background image missing at ${bgInDmg}`)
    }
    verifyDmgLayout(dmgbuildPython, verifyMount, bgDestName)
    console.log(
      `[build-dmg] verified: framework ${size} bytes, codesign valid, ` +
        `background ${bgDestName} present, Finder layout valid`,
    )
  } finally {
    detach(verifyMount)
  }

  return [dmgPath]
}
