/**
 * electron-builder afterAllArtifactBuild hook：手动用 hdiutil 打 dmg。
 *
 * 不用 electron-builder 内置 dmg-builder，因为它会丢 Electron Framework binary
 * （157MB 主库），装机后 dyld 报 "Library not loaded: @rpath/Electron Framework"。
 * hdiutil + ditto 能保留所有文件（含大文件 + symlink + xattr + 代码签名）。
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

exports.default = async function (context) {
  // context.outDir 是 release/，context.platformToTargets 包含 darwin → dir
  if (!context.outDir) return
  const macDir = path.join(context.outDir, 'mac-arm64')
  const appName = 'PlumeLens.app'
  const appPath = path.join(macDir, appName)
  if (!fs.existsSync(appPath)) {
    console.log(`[build-dmg] no app at ${appPath}, skip`)
    return []
  }
  const dmgPath = path.join(context.outDir, 'PlumeLens-0.1.0-arm64.dmg')
  if (fs.existsSync(dmgPath)) fs.rmSync(dmgPath)

  // 用 hdiutil create -srcfolder：从 macDir 直接打 dmg，保留 framework binary
  // -fs HFS+ 兼容老 macOS；-format UDZO 压缩 (~50% size)
  console.log(`[build-dmg] hdiutil create → ${dmgPath}`)
  execFileSync(
    'hdiutil',
    [
      'create',
      '-volname',
      'PlumeLens 0.1.0-arm64',
      '-srcfolder',
      macDir,
      '-ov',
      '-format',
      'UDZO',
      dmgPath,
    ],
    { stdio: 'inherit' },
  )

  // 验证 dmg 内 Framework binary 真的在
  console.log(`[build-dmg] verifying dmg contents...`)
  const mountInfo = execFileSync('hdiutil', [
    'attach',
    dmgPath,
    '-nobrowse',
    '-noautoopen',
    '-readonly',
  ]).toString()
  const mountMatch = mountInfo.match(/(\/Volumes\/PlumeLens[^\n]+)/)
  if (!mountMatch) {
    throw new Error('failed to detect mount point')
  }
  const mountPoint = mountMatch[1].trim()
  try {
    const fwBin = path.join(
      mountPoint,
      appName,
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
    execFileSync('codesign', [
      '--verify',
      '--deep',
      '--strict',
      path.join(mountPoint, appName),
    ], { stdio: 'inherit' })
    console.log(`[build-dmg] verified: framework binary ${size} bytes, codesign valid`)
  } finally {
    execFileSync('hdiutil', ['detach', mountPoint, '-quiet'])
  }

  return [dmgPath]
}
