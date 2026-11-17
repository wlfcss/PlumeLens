/** Preserve dependency licenses while omitting duplicate bundled node_modules. */
const fs = require('node:fs')
const path = require('node:path')

function collectDependencyNotices(projectRoot, resourcesDir) {
  const output = path.join(resourcesDir, 'third-party-notices')
  fs.mkdirSync(output, { recursive: true })
  const notices = []
  const seen = new Set()
  function visit(modules) {
    if (!fs.existsSync(modules)) return
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const directory = path.join(modules, entry.name)
      if (entry.name.startsWith('@')) {
        visit(directory)
        continue
      }
      const metadata = path.join(directory, 'package.json')
      if (!fs.existsSync(metadata)) continue
      const info = JSON.parse(fs.readFileSync(metadata, 'utf8'))
      const key = `${info.name}-${info.version}`
      if (!seen.has(key)) {
        seen.add(key)
        const files = fs
          .readdirSync(directory, { withFileTypes: true })
          .filter(
            (file) => file.isFile() && /^(licen[cs]e|notice|copying)([.-]|$)/i.test(file.name),
          )
        if (files.length) {
          const folder = key.replace(/[^a-zA-Z0-9._@-]/g, '_')
          fs.mkdirSync(path.join(output, folder), { recursive: true })
          for (const file of files)
            fs.copyFileSync(path.join(directory, file.name), path.join(output, folder, file.name))
          notices.push({
            name: info.name,
            version: info.version,
            license: info.license,
            files: files.map((file) => `${folder}/${file.name}`),
          })
        }
      }
      visit(path.join(directory, 'node_modules'))
    }
  }
  visit(path.join(projectRoot, 'node_modules'))
  if (!notices.length) throw new Error('No dependency licenses were collected')
  notices.sort((a, b) => a.name.localeCompare(b.name))
  fs.writeFileSync(path.join(output, 'index.json'), JSON.stringify(notices, null, 2))
  console.log(`[licenses] Preserved notices for ${notices.length} dependencies`)
}

module.exports = { collectDependencyNotices }
if (require.main === module)
  collectDependencyNotices(path.resolve(__dirname, '..'), path.resolve(process.argv[2]))
