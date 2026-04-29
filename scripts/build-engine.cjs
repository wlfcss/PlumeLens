/**
 * Build the frozen Python backend before Electron packaging.
 *
 * electron-builder only copies dist/plumelens-engine into the app bundle; it
 * does not know when Python sources changed. This hook makes that dependency
 * explicit so a fresh DMG cannot accidentally contain an old backend.
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const engineBin = path.join(repoRoot, 'dist', 'plumelens-engine', 'plumelens-engine')
const specFile = path.join(repoRoot, 'scripts', 'plumelens-engine.spec')

function walkFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__' || entry.name === '.venv') continue
      walkFiles(full, predicate, out)
    } else if (entry.isFile() && predicate(full)) {
      out.push(full)
    }
  }
  return out
}

function sourceFiles() {
  return [
    ...walkFiles(path.join(repoRoot, 'engine'), (file) => file.endsWith('.py')),
    specFile,
    path.join(repoRoot, 'pyproject.toml'),
    path.join(repoRoot, 'uv.lock'),
  ].filter((file) => fs.existsSync(file))
}

function latestSourceMtime() {
  return Math.max(...sourceFiles().map((file) => fs.statSync(file).mtimeMs))
}

function buildEngine() {
  console.log('[build-engine] rebuilding PyInstaller backend...')
  execFileSync('uv', ['run', 'pyinstaller', 'scripts/plumelens-engine.spec', '--clean', '--noconfirm'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (!fs.existsSync(engineBin)) {
    throw new Error(`PyInstaller did not create ${engineBin}`)
  }
  console.log('[build-engine] ready:', engineBin)
}

function ensureEngineFresh() {
  const force = process.env.PLUMELENS_FORCE_ENGINE_BUILD === '1'
  const latest = latestSourceMtime()
  const current = fs.existsSync(engineBin) ? fs.statSync(engineBin).mtimeMs : 0
  if (force || current < latest) {
    buildEngine()
    return
  }
  console.log('[build-engine] frozen backend is up to date')
}

exports.ensureEngineFresh = ensureEngineFresh
exports.default = async function () {
  ensureEngineFresh()
}

if (require.main === module) {
  ensureEngineFresh()
}
