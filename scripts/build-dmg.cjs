/**
 * electron-builder afterAllArtifactBuild hook：手动用 hdiutil 打 dmg。
 *
 * 不用 electron-builder 内置 dmg-builder，因为它会丢 Electron Framework binary
 * （157MB 主库），装机后 dyld 报 "Library not loaded: @rpath/Electron Framework"。
 * hdiutil + ditto 能保留所有文件（含大文件 + symlink + xattr + 代码签名）。
 *
 * 安装窗口外观:
 * 1) 先用 UDRW 创建可读写 dmg,挂上 staging 目录(.app + Applications symlink)。
 * 2) 拷 build/dmg-background.png 到 mount 内 .background/background.png。
 * 3) AppleScript 设 Finder 窗口大小、图标布局、隐藏 toolbar/sidebar/statusbar、
 *    把 .background/background.png 设为窗口背景图。
 * 4) sync + detach,转 UDZO 压缩格式发布。
 *
 * 重新生成背景图: ``uv run python scripts/build_dmg_background.py``。
 * 改图标坐标记得同步 build_dmg_background.py 的 LEFT_ICON_CENTER / RIGHT_ICON_CENTER。
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// 与 scripts/build_dmg_background.py 同步:窗口逻辑大小 640x400,图标坐标
// (左中点, 右中点) 在 Finder 里以左上角为原点的 logical points。AppleScript
// "set position" 接收的是 icon 中心坐标。
const WINDOW_W = 640
const WINDOW_H = 400
const APP_ICON_POS = { x: 180, y: 188 }
const APPLICATIONS_POS = { x: 460, y: 188 }
const ICON_SIZE = 128
const APP_NAME = 'PlumeLens.app'

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
      execFileSync('hdiutil', ['detach', mountPoint, '-quiet'])
      return
    } catch (err) {
      if (i === 2) throw err
      execFileSync('sleep', ['1'])
    }
  }
}

function applyDmgLayout(mountPoint, volumeName) {
  // AppleScript 通过 Finder 设置窗口外观 + 图标坐标 + 背景图。
  //
  // background picture 的稳定写法是 POSIX file → alias:
  //   set bg to POSIX file "/Volumes/xxx/.background/background.png" as alias
  //   set background picture of theViewOptions to bg
  // 直接用 "file '.background:background.png' of disk vol" 这种 Finder 老语法
  // 在 macOS 14+ 会被 Finder 当成"把 disk 设为文件",报"不能将 ... 设置为 ...",
  // 改用 POSIX 绝对路径就稳了。
  const bgPosixPath = `${mountPoint}/.background/background.png`
  const script = `
on run argv
  set vol to item 1 of argv
  set bgPosix to item 2 of argv
  set bgAlias to (POSIX file bgPosix) as alias
  tell application "Finder"
    tell disk vol
      open
      delay 1
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set sidebar width of container window to 0
      set the bounds of container window to {200, 120, ${200 + WINDOW_W}, ${120 + WINDOW_H}}
      set theViewOptions to the icon view options of container window
      set arrangement of theViewOptions to not arranged
      set icon size of theViewOptions to ${ICON_SIZE}
      set text size of theViewOptions to 13
      set label position of theViewOptions to bottom
      set shows item info of theViewOptions to false
      set shows icon preview of theViewOptions to false
      try
        set background picture of theViewOptions to bgAlias
      on error errMsg
        log "background picture failed: " & errMsg
      end try
      set position of item "${APP_NAME}" of container window to {${APP_ICON_POS.x}, ${APP_ICON_POS.y}}
      set position of item "Applications" of container window to {${APPLICATIONS_POS.x}, ${APPLICATIONS_POS.y}}
      update without registering applications
      -- 给 Finder 时间把 .DS_Store 写盘,detach 太快会丢窗口设置
      delay 2
      close
    end tell
  end tell
end run
`.trim()

  execFileSync('osascript', ['-', volumeName, bgPosixPath], {
    input: script,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
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

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumelens-dmg-'))
  console.log(`[build-dmg] staging in ${stagingDir}`)
  const volumeName = `鉴翎 ${pkgVersion}`

  try {
    // ditto 保留 ACL/xattr/签名
    execFileSync('ditto', [appPath, path.join(stagingDir, APP_NAME)], { stdio: 'inherit' })
    fs.symlinkSync('/Applications', path.join(stagingDir, 'Applications'))

    // .background 目录 + 背景图
    const bgSrc = path.join(__dirname, '..', 'build', 'dmg-background.png')
    if (!fs.existsSync(bgSrc)) {
      throw new Error(
        `dmg-background.png missing at ${bgSrc}. ` +
          `Regenerate via: uv run python scripts/build_dmg_background.py`,
      )
    }
    const bgDir = path.join(stagingDir, '.background')
    fs.mkdirSync(bgDir, { recursive: true })
    fs.copyFileSync(bgSrc, path.join(bgDir, 'background.png'))

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

    // 2) 挂载,跑 AppleScript 设布局
    const mountPoint = attachReadWrite(tmpDmg)
    try {
      console.log(`[build-dmg] applying Finder layout at ${mountPoint}`)
      applyDmgLayout(mountPoint, volumeName)
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
    execFileSync(
      'codesign',
      ['--verify', '--deep', '--strict', path.join(verifyMount, APP_NAME)],
      { stdio: 'inherit' },
    )
    // 验证背景图也在 dmg 里
    const bgInDmg = path.join(verifyMount, '.background', 'background.png')
    if (!fs.existsSync(bgInDmg)) {
      throw new Error(`DMG background image missing at ${bgInDmg}`)
    }
    console.log(`[build-dmg] verified: framework ${size} bytes, codesign valid, background present`)
  } finally {
    detach(verifyMount)
  }

  return [dmgPath]
}
