/**
 * electron-builder afterAllArtifactBuild hook：手动用 hdiutil 打 dmg。
 *
 * 不用 electron-builder 内置 dmg-builder，因为它会丢 Electron Framework binary
 * （157MB 主库），装机后 dyld 报 "Library not loaded: @rpath/Electron Framework"。
 * hdiutil + ditto 能保留所有文件（含大文件 + symlink + xattr + 代码签名）。
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
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
  // 版本号从 package.json 读，保持与项目元数据同步（之前 0.1.0 硬编码导致升 0.2 漏改）
  const pkgVersion = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  ).version
  const dmgPath = path.join(context.outDir, `PlumeLens-${pkgVersion}-arm64.dmg`)
  if (fs.existsSync(dmgPath)) fs.rmSync(dmgPath)

  // 准备 staging 目录：含 .app（ditto 保留签名 + xattr）+ /Applications symlink
  // 让用户挂 dmg 时看到熟悉的 "拖到 Applications" 安装提示
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumelens-dmg-'))
  console.log(`[build-dmg] staging in ${stagingDir}`)
  try {
    // 用 ditto 复制 .app（macOS 推荐，保留 ACL/xattr/签名 完整）
    execFileSync('ditto', [appPath, path.join(stagingDir, appName)], { stdio: 'inherit' })
    // /Applications 符号链接（dmg 安装界面右侧的 "拖到这里"）
    fs.symlinkSync('/Applications', path.join(stagingDir, 'Applications'))

    console.log(`[build-dmg] hdiutil create → ${dmgPath}`)
    execFileSync(
      'hdiutil',
      [
        'create',
        '-volname',
        `PlumeLens ${pkgVersion}-arm64`,
        '-srcfolder',
        stagingDir,
        '-ov',
        '-format',
        'UDZO',
        dmgPath,
      ],
      { stdio: 'inherit' },
    )
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true })
  }

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
