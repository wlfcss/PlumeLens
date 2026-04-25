/**
 * electron-builder afterPack hook：对打包后的 .app 做 ad-hoc codesign。
 *
 * 为什么需要：
 * - 未签名 .app 拖到 /Applications/ 后，macOS quarantine 会破坏 Electron Framework
 *   的目录结构（symlink 或 framework version subdir 被改），导致启动时
 *   `Library not loaded: @rpath/Electron Framework.framework/Electron Framework`。
 * - electron-builder 内置 identity:'-' 走 @electron/osx-sign，子依赖 isbinaryfile
 *   遇 PyInstaller frozen binary 报 RangeError，build 失败。
 * - 直接调系统 `codesign -s -` 命令签整个 .app（递归 + deep），稳定不卡。
 *
 * 注意：ad-hoc 签名只是让 macOS 接受 framework 完整性，不能通过 Apple notarization；
 * 用户首次启动仍需右键 → 打开（绕过 Gatekeeper），但不会再触发 framework 缺失崩溃。
 */
const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const entitlementsPath = path.resolve(__dirname, '..', 'build', 'entitlements.mac.plist')
  if (!fs.existsSync(entitlementsPath)) {
    throw new Error(`entitlements file missing: ${entitlementsPath}`)
  }
  console.log(`[codesign] ad-hoc signing ${appPath}`)
  console.log(`[codesign] entitlements: ${entitlementsPath}`)
  try {
    // 用 --deep 时 entitlements 不会传给 nested binaries（Apple 设计），
    // 必须显式给 main app 指定 entitlements，让 V8/Helper 进程继承
    execFileSync(
      'codesign',
      [
        '--force',
        '--deep',
        '--sign',
        '-',
        '--options',
        'runtime',
        '--entitlements',
        entitlementsPath,
        '--timestamp=none',
        appPath,
      ],
      { stdio: 'inherit' },
    )
    // 验证 + 输出 entitlements（确认 com.apple.security.cs.allow-jit 等生效）
    execFileSync('codesign', ['--verify', '--verbose', appPath], { stdio: 'inherit' })
    const ent = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', appPath]).toString()
    if (!ent.includes('com.apple.security.cs.allow-jit')) {
      throw new Error('entitlements not properly embedded (allow-jit missing)')
    }
    console.log('[codesign] ad-hoc signature + entitlements verified')
  } catch (err) {
    console.error('[codesign] failed:', err.message)
    throw err
  }
}
