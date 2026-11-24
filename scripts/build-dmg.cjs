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
const path = require('path')
const { createDmgMount, cleanupDmgWorkspace } = require('./dmg-mount.cjs')

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
  if (process.platform !== 'darwin') return []
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

  // Keep candidate and final image on the same filesystem for atomic publication.
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(context.outDir, '.plumelens-dmg-')))
  const stagingDir = path.join(workspace, 'staging')
  const tmpDmg = path.join(workspace, 'image.rw.dmg')
  const candidateDmg = path.join(workspace, 'release.dmg')
  const rwMount = createDmgMount(tmpDmg, path.join(workspace, 'readwrite'))
  const verifyMount = createDmgMount(candidateDmg, path.join(workspace, 'verify'))
  const previousOutput = createDmgMount(dmgPath, path.join(workspace, 'previous-output'))
  console.log(`[build-dmg] task workspace ${workspace}`)
  let buildError
  try {
    // A previous build or the user may still have the existing output open.
    // Never detach it or delete its backing file, even if the version matches.
    previousOutput.assertDetached()
    fs.mkdirSync(stagingDir)
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
    const mountPoint = rwMount.attach()
    try {
      console.log(`[build-dmg] writing Finder layout at ${mountPoint}`)
      writeDmgLayout(dmgbuildPython, mountPoint, bgDestName)
      // sync 确保 .DS_Store 落盘后再 detach,否则窗口配置丢失
      execFileSync('sync')
    } finally {
      await rwMount.detach()
    }

    // 3) 转换为 LZFSE (ULFO) 压缩发布版（macOS 10.11+ 原生支持，最低基线 14.0 完全兼容，
    // 相比 UDZO zlib-level=9 在不可压缩模型权重上显著减少 CI 耗时且体积相当）
    console.log(`[build-dmg] hdiutil convert (ULFO) → ${candidateDmg}`)
    execFileSync('hdiutil', ['convert', tmpDmg, '-format', 'ULFO', '-o', candidateDmg], {
      stdio: 'inherit',
    })
    // 验证 dmg 内 Framework binary 真的在
    console.log(`[build-dmg] verifying dmg contents...`)
    const verifyMountPoint = verifyMount.attach(true)
    try {
      const fwBin = path.join(
        verifyMountPoint,
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
      execFileSync(
        'codesign',
        ['--verify', '--deep', '--strict', path.join(verifyMountPoint, APP_NAME)],
        {
          stdio: 'inherit',
        },
      )
      // 验证背景图也在 dmg 里
      const bgInDmg = path.join(verifyMountPoint, bgDestName)
      if (!fs.existsSync(bgInDmg)) {
        throw new Error(`DMG background image missing at ${bgInDmg}`)
      }
      verifyDmgLayout(dmgbuildPython, verifyMountPoint, bgDestName)
      console.log(
        `[build-dmg] verified: framework ${size} bytes, codesign valid, ` +
          `background ${bgDestName} present, Finder layout valid`,
      )
    } finally {
      await verifyMount.detach()
    }

    previousOutput.assertDetached()
    fs.renameSync(candidateDmg, dmgPath)
    return [dmgPath]
  } catch (error) {
    buildError = error
    throw error
  } finally {
    try {
      cleanupDmgWorkspace(workspace, [rwMount, verifyMount])
    } catch (error) {
      console.error(`[build-dmg] retaining task workspace ${workspace}: ${error.message}`)
      if (!buildError) throw error
    }
  }
}
