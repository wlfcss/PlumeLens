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
const engineBin = path.join(
  repoRoot,
  'dist',
  'plumelens-engine',
  process.platform === 'win32' ? 'plumelens-engine.exe' : 'plumelens-engine',
)
const specFile = path.join(repoRoot, 'scripts', 'plumelens-engine.spec')
const stampFile = path.join(repoRoot, 'dist', 'plumelens-engine', '.build-stamp.json')

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
    ...walkFiles(path.join(repoRoot, 'engine', 'data'), (file) =>
      /\.(npz|json|parquet)$/i.test(file),
    ),
    specFile,
    path.join(repoRoot, 'scripts', 'windows_runtime_policy.py'),
    path.join(repoRoot, 'pyproject.toml'),
    path.join(repoRoot, 'uv.lock'),
  ].filter((file) => fs.existsSync(file))
}

function currentPythonVersion() {
  try {
    const out = execFileSync(
      process.env.PLUMELENS_PYTHON || 'uv',
      process.env.PLUMELENS_PYTHON
        ? ['--version']
        : ['run', 'python', '--version'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return out.trim()
  } catch {
    return null
  }
}

function readBuildStamp() {
  if (!fs.existsSync(stampFile)) return null
  try {
    return JSON.parse(fs.readFileSync(stampFile, 'utf8'))
  } catch {
    return null
  }
}

function writeBuildStamp(pythonVersion) {
  try {
    fs.writeFileSync(
      stampFile,
      JSON.stringify({ pythonVersion, builtAt: new Date().toISOString() }, null, 2),
      'utf8',
    )
  } catch {
    /* non-critical stamp failure */
  }
}

function latestSourceMtime() {
  return Math.max(...sourceFiles().map((file) => fs.statSync(file).mtimeMs))
}

function buildEngine() {
  console.log('[build-engine] rebuilding PyInstaller backend...')
  execFileSync(
    process.env.PLUMELENS_PYTHON || 'uv',
    process.env.PLUMELENS_PYTHON
      ? ['-m', 'PyInstaller', 'scripts/plumelens-engine.spec', '--clean', '--noconfirm']
      : ['run', 'pyinstaller', 'scripts/plumelens-engine.spec', '--clean', '--noconfirm'],
    {
      cwd: repoRoot,
      stdio: 'inherit',
    },
  )
  if (!fs.existsSync(engineBin)) {
    throw new Error(`PyInstaller did not create ${engineBin}`)
  }
  writeBuildStamp(currentPythonVersion())
  console.log('[build-engine] ready:', engineBin)
}

function ensureEngineFresh() {
  const force = process.env.PLUMELENS_FORCE_ENGINE_BUILD === '1'
  const latest = latestSourceMtime()
  const current = fs.existsSync(engineBin) ? fs.statSync(engineBin).mtimeMs : 0
  const stamp = readBuildStamp()
  const pyVer = currentPythonVersion()
  const pythonChanged = Boolean(stamp?.pythonVersion && pyVer && stamp.pythonVersion !== pyVer)
  if (force || current < latest || pythonChanged) {
    if (pythonChanged) {
      console.log(
        `[build-engine] Python version changed (${stamp.pythonVersion} -> ${pyVer}), rebuilding...`,
      )
    }
    buildEngine()
    return
  }
  console.log('[build-engine] frozen backend is up to date')
}

exports.sourceFiles = sourceFiles
exports.ensureEngineFresh = ensureEngineFresh
exports.default = async function () {
  ensureEngineFresh()
}

if (require.main === module) {
  ensureEngineFresh()
}
