/**
 * electron-builder afterPack hook：手动 ad-hoc codesign 整个 .app。
 *
 * 为什么不能用 codesign --deep：
 * - --deep 在新版 macOS 已 deprecated，且 --entitlements 不会递归到 nested binary
 * - 结果：Helper (Renderer/GPU/Plugin) 没继承 disable-library-validation entitlement
 *   → macOS library validation 拦截 Electron Framework 加载 → dyld 误报 "Library missing"
 *
 * 正确做法：自底向上逐个签：
 *   1. 所有 .dylib / .so / 可执行 binary（PyInstaller _internal/ 内的 native libs）
 *   2. Frameworks/*.framework
 *   3. Frameworks/Helper apps（用 inherit entitlements，让它们自动继承父 entitlements）
 *   4. 最后签顶层 .app（用完整 entitlements）
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const SIGN_ID = '-' // ad-hoc

function run(args, opts = {}) {
  return execFileSync('codesign', args, { stdio: 'inherit', ...opts })
}

function sign(target, entitlementsFile, label = '') {
  const args = [
    '--force',
    '--sign',
    SIGN_ID,
    '--options',
    'runtime',
    '--timestamp=none',
    '--entitlements',
    entitlementsFile,
    target,
  ]
  console.log(`[codesign] ${label || target}`)
  run(args)
}

function findRecursive(dir, predicate) {
  const out = []
  if (!fs.existsSync(dir)) return out
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name)
      // 不递归进 .framework / .app（它们由 caller 单独处理签名）
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.framework') || entry.name.endsWith('.app')) continue
        stack.push(full)
      } else if (entry.isFile() && predicate(full, entry)) {
        out.push(full)
      }
    }
  }
  return out
}

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const entMain = path.resolve(__dirname, '..', 'build', 'entitlements.mac.plist')
  const entInherit = path.resolve(__dirname, '..', 'build', 'entitlements.mac.inherit.plist')
  if (!fs.existsSync(entMain)) throw new Error(`entitlements missing: ${entMain}`)
  if (!fs.existsSync(entInherit)) throw new Error(`inherit entitlements missing: ${entInherit}`)
  console.log(`[codesign] target: ${appPath}`)

  // 1. PyInstaller _internal/ 里的所有 .dylib 和原生 .so / 二进制
  const engineDir = path.join(appPath, 'Contents', 'Resources', 'plumelens-engine')
  const dylibs = findRecursive(engineDir, (full) => {
    const lower = full.toLowerCase()
    return (
      lower.endsWith('.dylib') ||
      lower.endsWith('.so') ||
      lower.endsWith('.cpython-312-darwin.so')
    )
  })
  for (const f of dylibs) sign(f, entInherit, `dylib: ${path.basename(f)}`)

  // PyInstaller 主 binary
  const engineBin = path.join(engineDir, 'plumelens-engine')
  if (fs.existsSync(engineBin)) sign(engineBin, entInherit, 'plumelens-engine binary')

  // 2. Frameworks/*.framework — 签每个 framework 内的 versioned binary
  const fwRoot = path.join(appPath, 'Contents', 'Frameworks')
  if (fs.existsSync(fwRoot)) {
    for (const name of fs.readdirSync(fwRoot)) {
      const item = path.join(fwRoot, name)
      if (name.endsWith('.framework')) {
        sign(item, entInherit, `framework: ${name}`)
      }
    }
  }

  // 3. Frameworks/*.app（Helper apps）—— 用 inherit entitlements
  if (fs.existsSync(fwRoot)) {
    for (const name of fs.readdirSync(fwRoot)) {
      if (name.endsWith('.app')) {
        sign(path.join(fwRoot, name), entInherit, `helper app: ${name}`)
      }
    }
  }

  // 4. 最后签顶层 .app —— 用完整 entitlements
  sign(appPath, entMain, 'main app')

  // 5. 验证 + 输出 entitlements
  console.log(`[codesign] verifying...`)
  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { stdio: 'inherit' },
  )
  const ent = execFileSync('codesign', [
    '-d', '--entitlements', '-', '--xml', appPath,
  ]).toString()
  if (!ent.includes('com.apple.security.cs.allow-jit')) {
    throw new Error('main app entitlements missing allow-jit')
  }
  if (!ent.includes('com.apple.security.cs.disable-library-validation')) {
    throw new Error('main app entitlements missing disable-library-validation')
  }
  console.log(`[codesign] all signed and verified`)
}
