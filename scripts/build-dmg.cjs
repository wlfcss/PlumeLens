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

function applyDmgLayout(mountPoint, volumeName, bgFileName) {
  // AppleScript 通过 Finder 设置窗口外观 + 图标坐标 + 背景图。
  //
  // background picture 的稳定写法是 POSIX file → alias:
  //   set bg to POSIX file "/Volumes/xxx/.background/background.tiff" as alias
  //   set background picture of theViewOptions to bg
  // 直接用 "file '.background:background.png' of disk vol" 这种 Finder 老语法
  // 在 macOS 14+ 会被 Finder 当成"把 disk 设为文件",报"不能将 ... 设置为 ...",
  // 改用 POSIX 绝对路径就稳了。
  const bgPosixPath = `${mountPoint}/.background/${bgFileName}`
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

  // 防御:detach 任何挂着的同名/旧 dmg volume,避免 macOS 自动加数字后缀
  // 让 Finder 不识别新 dmg 的 DS_Store layout。
  detachStaleVolumes()

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumelens-dmg-'))
  console.log(`[build-dmg] staging in ${stagingDir}`)
  const volumeName = `鉴翎 ${pkgVersion}`

  // 选择背景图源 — 优先 multi-rep TIFF(retina 用 @2× rep,字体清晰),
  // tiffutil/sips 缺失时回落到 1× PNG。提到 try 块外 — 验证步骤在 finally
  // 之后还需要引用 bgDestName。
  const bgTiff = path.join(__dirname, '..', 'build', 'dmg-background.tiff')
  const bgPng = path.join(__dirname, '..', 'build', 'dmg-background.png')
  let bgSrc, bgDestName
  if (fs.existsSync(bgTiff)) {
    bgSrc = bgTiff
    bgDestName = 'background.tiff'
  } else if (fs.existsSync(bgPng)) {
    console.log('[build-dmg] HiDPI TIFF missing, falling back to single-rep PNG')
    bgSrc = bgPng
    bgDestName = 'background.png'
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
    const bgDir = path.join(stagingDir, '.background')
    fs.mkdirSync(bgDir, { recursive: true })
    fs.copyFileSync(bgSrc, path.join(bgDir, bgDestName))
    // .background 目录权限收紧 — Finder 不需要写权限
    fs.chmodSync(bgDir, 0o755)

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
      applyDmgLayout(mountPoint, volumeName, bgDestName)
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
    const bgInDmg = path.join(verifyMount, '.background', bgDestName)
    if (!fs.existsSync(bgInDmg)) {
      throw new Error(`DMG background image missing at ${bgInDmg}`)
    }
    console.log(
      `[build-dmg] verified: framework ${size} bytes, codesign valid, ` +
        `background ${bgDestName} present`,
    )
  } finally {
    detach(verifyMount)
  }

  return [dmgPath]
}
