/** Apply native branding without requiring Windows symbolic-link privileges. */
const fs = require('node:fs')
const path = require('node:path')

exports.default = async function (context) {
  const bundle =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents')
      : context.appOutDir
  require('./collect-dependency-notices.cjs').collectDependencyNotices(
    path.join(__dirname, '..'),
    path.join(bundle, context.electronPlatformName === 'darwin' ? 'Resources' : 'resources'),
  )
  if (context.electronPlatformName === 'darwin') {
    return require('./codesign-mac.cjs').default(context)
  }
  if (context.electronPlatformName !== 'win32') return

  const { NtExecutable, NtExecutableResource, Resource, Data } = require('resedit')
  const info = context.packager.appInfo
  const executablePath = path.join(context.appOutDir, `${info.productFilename}.exe`)
  const executable = NtExecutable.from(fs.readFileSync(executablePath))
  const resources = NtExecutableResource.from(executable)
  const version = Resource.VersionInfo.fromEntries(resources.entries)[0]
  const parts = info.version.split('.').map((part) => parseInt(part, 10) || 0)
  version.setFileVersion(parts[0], parts[1], parts[2], 0, 1033)
  version.setProductVersion(parts[0], parts[1], parts[2], 0, 1033)
  version.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      ProductName: info.productName,
      FileDescription: info.productName,
      CompanyName: info.companyName || '',
      LegalCopyright: info.copyright,
      InternalName: info.productFilename,
      OriginalFilename: `${info.productFilename}.exe`,
    },
  )
  version.outputToResourceEntries(resources.entries)
  const icon = Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.ico')))
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries)
  for (const group of groups) {
    Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      group.id,
      group.lang,
      icon.icons.map((entry) => entry.data),
    )
  }
  resources.outputResource(executable)
  fs.writeFileSync(executablePath, Buffer.from(executable.generate()))
  console.log('[after-pack] Windows icon and version resources updated')
}
