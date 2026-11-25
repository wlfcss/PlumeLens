/**
 * Hardware & OS system profile collector for diagnostics.
 *
 * Collects complete information for:
 * - Program install disk & userData disk (mount, filesystem, capacity, SSD/HDD, bus protocol, model)
 * - CPU (model, arch, logical/physical cores, Apple Silicon P/E cores, frequency, caches)
 * - Memory (total/free, unified memory flag, RAM type/speed/modules, Electron process RSS)
 * - GPU (Electron GPUInfo + macOS SPDisplays cores/Metal / Windows VideoController + 64-bit VRAM)
 *
 * Every external OS probe runs asynchronously with a short timeout and graceful
 * fallback so startup or diagnostics export can never hang or fail.
 */

import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { statfs } from 'fs/promises'
import { arch as osArch, cpus as osCpus, freemem, platform as osPlatform, release as osRelease, totalmem, version as osVersion } from 'os'
import { dirname, join, parse as parsePath } from 'path'
import { promisify } from 'util'
import type {
  CpuProfileInfo,
  DiskProbeInfo,
  GpuDeviceInfo,
  MemoryProfileInfo,
  SystemProfileSnapshot,
} from '../shared/client-log'
import { writeTextAtomicSync } from './atomic-file'
import type { DeviceIdSource } from './device-id'
import { redactText } from './log-redactor'

const execFileAsync = promisify(execFile)
const PROBE_TIMEOUT_MS = 3500

async function runCommandSafe(
  command: string,
  args: string[],
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    })
    return stdout
  } catch {
    return null
  }
}

function parsePlistString(plist: string, key: string): string | null {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`)
  const match = plist.match(re)
  return match?.[1]?.trim() ? match[1].trim() : null
}

function parsePlistBool(plist: string, key: string): boolean | null {
  const re = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`)
  const match = plist.match(re)
  if (!match) return null
  return match[1] === 'true'
}

async function probeDiskStatfs(targetPath: string): Promise<{
  totalBytes: number | null
  freeBytes: number | null
  availableBytes: number | null
  usedPercent: number | null
}> {
  let probeTarget = targetPath
  while (!existsSync(probeTarget)) {
    const parent = dirname(probeTarget)
    if (parent === probeTarget) break
    probeTarget = parent
  }
  try {
    const st = await statfs(probeTarget)
    const blockSize = Number(st.bsize)
    const totalBytes = Number(st.blocks) * blockSize
    const freeBytes = Number(st.bfree) * blockSize
    const availableBytes = Number(st.bavail) * blockSize
    const usedPercent =
      totalBytes > 0 ? Math.round(((totalBytes - availableBytes) / totalBytes) * 1000) / 10 : null
    return { totalBytes, freeBytes, availableBytes, usedPercent }
  } catch {
    return { totalBytes: null, freeBytes: null, availableBytes: null, usedPercent: null }
  }
}

async function probeMacDiskMetadata(targetPath: string): Promise<Partial<DiskProbeInfo>> {
  let probeTarget = targetPath
  while (!existsSync(probeTarget)) {
    const parent = dirname(probeTarget)
    if (parent === probeTarget) break
    probeTarget = parent
  }
  const dfOut = await runCommandSafe('df', ['-P', probeTarget], 2000)
  let mountPoint: string | null = null
  let deviceNode: string | null = null
  if (dfOut) {
    const lines = dfOut.trim().split('\n')
    const dataLine = lines[lines.length - 1]
    if (dataLine) {
      const parts = dataLine.trim().split(/\s+/)
      deviceNode = parts[0] ?? null
      mountPoint = parts.slice(5).join(' ') || null
    }
  }

  const target = mountPoint ?? deviceNode ?? probeTarget
  const plist = await runCommandSafe('diskutil', ['info', '-plist', target], PROBE_TIMEOUT_MS)
  if (!plist) {
    return {
      mountPoint,
      mediaType: deviceNode?.startsWith('//') ? 'Network' : 'Unknown',
    }
  }

  const solidState = parsePlistBool(plist, 'SolidState')
  const isInternal = parsePlistBool(plist, 'Internal')
  const busProtocol = parsePlistString(plist, 'BusProtocol')
  const filesystem =
    parsePlistString(plist, 'FilesystemName') ??
    parsePlistString(plist, 'FilesystemType') ??
    parsePlistString(plist, 'Content')
  const model =
    parsePlistString(plist, 'MediaName') ??
    parsePlistString(plist, 'IORegistryEntryName')
  const resolvedMount = parsePlistString(plist, 'MountPoint') ?? mountPoint

  let mediaType: DiskProbeInfo['mediaType'] = 'Unknown'
  if (solidState === true) mediaType = 'SSD'
  else if (solidState === false) mediaType = 'HDD'
  else if (busProtocol?.toLowerCase().includes('apple fabric') || busProtocol?.toLowerCase().includes('nvme')) {
    mediaType = 'SSD'
  }

  return {
    mountPoint: resolvedMount,
    filesystem,
    mediaType,
    busProtocol,
    isInternal,
    model,
  }
}

async function probeWindowsDiskMetadata(targetPath: string): Promise<Partial<DiskProbeInfo>> {
  const root = parsePath(targetPath).root
  const driveMatch = root.match(/^([A-Za-z]):/)
  if (!driveMatch?.[1]) {
    return {
      mountPoint: root || null,
      mediaType: targetPath.startsWith('\\\\') ? 'Network' : 'Unknown',
    }
  }
  const driveLetter = driveMatch[1].toUpperCase()
  const psScript = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$vol = Get-Volume -DriveLetter '${driveLetter}'`,
    `$part = Get-Partition -DriveLetter '${driveLetter}'`,
    `$disk = if ($part) { Get-Disk -Number $part.DiskNumber } else { $null }`,
    `$phys = if ($disk) { Get-PhysicalDisk | Where-Object { $_.DeviceId -eq [string]$disk.Number } | Select-Object -First 1 } else { $null }`,
    `@{`,
    `  FileSystem = if ($vol) { $vol.FileSystem } else { $null };`,
    `  DriveType = if ($vol) { [string]$vol.DriveType } else { $null };`,
    `  BusType = if ($disk) { [string]$disk.BusType } else { $null };`,
    `  Model = if ($disk) { $disk.FriendlyName } else { $null };`,
    `  MediaType = if ($phys) { [string]$phys.MediaType } else { $null };`,
    `  IsSystem = if ($disk) { [bool]$disk.IsSystem } else { $null }`,
    `} | ConvertTo-Json -Compress`,
  ].join('; ')

  const raw = await runCommandSafe(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    PROBE_TIMEOUT_MS,
  )
  if (!raw) {
    return { mountPoint: `${driveLetter}:\\` }
  }
  try {
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>
    const rawMedia = String(parsed['MediaType'] ?? '').toUpperCase()
    const bus = typeof parsed['BusType'] === 'string' && parsed['BusType'] ? parsed['BusType'] : null
    const driveType = String(parsed['DriveType'] ?? '')
    let mediaType: DiskProbeInfo['mediaType'] = 'Unknown'
    if (rawMedia.includes('SSD')) mediaType = 'SSD'
    else if (rawMedia.includes('HDD')) mediaType = 'HDD'
    else if (bus?.toUpperCase() === 'NVME') mediaType = 'SSD'
    else if (driveType.toLowerCase() === 'remote') mediaType = 'Network'

    const isInternal =
      bus !== null
        ? !['USB', 'SD', 'MMC', '1394', 'FILE BACKED VIRTUAL'].includes(bus.toUpperCase())
        : null

    return {
      mountPoint: `${driveLetter}:\\`,
      filesystem: typeof parsed['FileSystem'] === 'string' ? parsed['FileSystem'] : null,
      mediaType,
      busProtocol: bus,
      isInternal,
      model: typeof parsed['Model'] === 'string' ? parsed['Model'] : null,
    }
  } catch {
    return { mountPoint: `${driveLetter}:\\` }
  }
}

export async function probeDiskForPath(
  role: DiskProbeInfo['role'],
  targetPath: string,
): Promise<DiskProbeInfo> {
  const [space, meta] = await Promise.all([
    probeDiskStatfs(targetPath),
    osPlatform() === 'darwin'
      ? probeMacDiskMetadata(targetPath)
      : osPlatform() === 'win32'
        ? probeWindowsDiskMetadata(targetPath)
        : Promise.resolve<Partial<DiskProbeInfo>>({ mountPoint: parsePath(targetPath).root || '/' }),
  ])

  return {
    role,
    mountPoint: meta.mountPoint ?? null,
    filesystem: meta.filesystem ?? null,
    mediaType: meta.mediaType ?? 'Unknown',
    busProtocol: meta.busProtocol ?? null,
    isInternal: meta.isInternal ?? null,
    model: meta.model ?? null,
    totalBytes: space.totalBytes,
    freeBytes: space.freeBytes,
    availableBytes: space.availableBytes,
    usedPercent: space.usedPercent,
  }
}

async function probeCpuProfile(): Promise<CpuProfileInfo> {
  const cpuList = osCpus()
  const first = cpuList[0]
  const base: CpuProfileInfo = {
    model: first?.model?.trim() || 'Unknown CPU',
    arch: osArch(),
    logicalCores: cpuList.length,
    physicalCores: null,
    performanceCores: null,
    efficiencyCores: null,
    baseSpeedMhz: first?.speed && first.speed > 0 ? first.speed : null,
    maxSpeedMhz: null,
    l2CacheBytes: null,
    l3CacheBytes: null,
  }

  if (osPlatform() === 'darwin') {
    // Use `-i` so missing keys on Apple Silicon (e.g. hw.l3cachesize) are ignored
    // rather than causing the entire sysctl batch to exit non-zero.
    const detailOut = await runCommandSafe('sysctl', [
      '-i',
      'machdep.cpu.brand_string',
      'hw.physicalcpu',
      'hw.logicalcpu',
      'hw.perflevel0.physicalcpu',
      'hw.perflevel1.physicalcpu',
      'hw.l2cachesize',
      'hw.l3cachesize',
      'hw.perflevel0.l2cachesize',
    ])
    if (detailOut) {
      const strKv = new Map<string, string>()
      const numKv = new Map<string, number>()
      for (const line of detailOut.split('\n')) {
        const idx = line.indexOf(':')
        if (idx === -1) continue
        const key = line.slice(0, idx).trim()
        const rawVal = line.slice(idx + 1).trim()
        if (rawVal) strKv.set(key, rawVal)
        const val = Number.parseInt(rawVal, 10)
        if (Number.isFinite(val) && val > 0) numKv.set(key, val)
      }
      const brand = strKv.get('machdep.cpu.brand_string')
      if (brand) base.model = brand
      if (numKv.has('hw.physicalcpu')) base.physicalCores = numKv.get('hw.physicalcpu') ?? null
      if (numKv.has('hw.logicalcpu')) base.logicalCores = numKv.get('hw.logicalcpu') ?? base.logicalCores
      if (numKv.has('hw.perflevel0.physicalcpu')) {
        base.performanceCores = numKv.get('hw.perflevel0.physicalcpu') ?? null
      }
      if (numKv.has('hw.perflevel1.physicalcpu')) {
        base.efficiencyCores = numKv.get('hw.perflevel1.physicalcpu') ?? null
      }
      base.l2CacheBytes = numKv.get('hw.l2cachesize') ?? numKv.get('hw.perflevel0.l2cachesize') ?? null
      base.l3CacheBytes = numKv.get('hw.l3cachesize') ?? null
    }
    return base
  }

  if (osPlatform() === 'win32') {
    const out = await runCommandSafe('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,L2CacheSize,L3CacheSize | ConvertTo-Json -Compress',
    ])
    if (out) {
      try {
        const parsed = JSON.parse(out.trim()) as Record<string, unknown>
        if (typeof parsed['Name'] === 'string' && parsed['Name'].trim()) {
          base.model = parsed['Name'].trim()
        }
        if (typeof parsed['NumberOfCores'] === 'number') base.physicalCores = parsed['NumberOfCores']
        if (typeof parsed['NumberOfLogicalProcessors'] === 'number') {
          base.logicalCores = parsed['NumberOfLogicalProcessors']
        }
        if (typeof parsed['MaxClockSpeed'] === 'number' && parsed['MaxClockSpeed'] > 0) {
          base.maxSpeedMhz = parsed['MaxClockSpeed']
        }
        if (typeof parsed['L2CacheSize'] === 'number' && parsed['L2CacheSize'] > 0) {
          base.l2CacheBytes = parsed['L2CacheSize'] * 1024
        }
        if (typeof parsed['L3CacheSize'] === 'number' && parsed['L3CacheSize'] > 0) {
          base.l3CacheBytes = parsed['L3CacheSize'] * 1024
        }
      } catch {
        /* fallback to os.cpus() */
      }
    }
  }

  return base
}

function getElectronAppMemoryRssBytes(): number | null {
  try {
    if (typeof app?.getAppMetrics === 'function') {
      const metrics = app.getAppMetrics()
      let totalKb = 0
      for (const m of metrics) {
        totalKb += m.memory.workingSetSize || 0
      }
      return totalKb > 0 ? totalKb * 1024 : null
    }
  } catch {
    /* ignore */
  }
  return process.memoryUsage().rss
}

async function probeMemoryProfile(): Promise<MemoryProfileInfo> {
  const totalBytes = totalmem()
  const freeBytes = freemem()
  const usedPercent =
    totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10 : 0
  const profile: MemoryProfileInfo = {
    totalBytes,
    freeBytes,
    usedPercent,
    unifiedMemory: osPlatform() === 'darwin' && osArch() === 'arm64',
    memoryType: null,
    speedMhz: null,
    moduleCount: null,
    appProcessRssBytes: getElectronAppMemoryRssBytes(),
  }

  if (osPlatform() === 'darwin') {
    const out = await runCommandSafe('system_profiler', ['SPMemoryDataType', '-json'], 4000)
    if (out) {
      try {
        const parsed = JSON.parse(out) as { SPMemoryDataType?: Array<Record<string, unknown>> }
        const first = parsed.SPMemoryDataType?.[0]
        if (first) {
          if (typeof first['dimm_type'] === 'string') profile.memoryType = first['dimm_type']
          const items = first['_items']
          if (Array.isArray(items) && items.length > 0) {
            profile.moduleCount = items.length
            const item0 = items[0] as Record<string, unknown>
            if (!profile.memoryType && typeof item0['dimm_type'] === 'string') {
              profile.memoryType = item0['dimm_type']
            }
            if (typeof item0['dimm_speed'] === 'string') {
              const m = item0['dimm_speed'].match(/(\d+)/)
              if (m?.[1]) profile.speedMhz = Number.parseInt(m[1], 10)
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    return profile
  }

  if (osPlatform() === 'win32') {
    const out = await runCommandSafe('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '@(Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity,ConfiguredClockSpeed,Speed,SMBIOSMemoryType) | ConvertTo-Json -Compress',
    ])
    if (out) {
      try {
        const raw = JSON.parse(out.trim()) as unknown
        const modules = Array.isArray(raw) ? raw : raw ? [raw] : []
        if (modules.length > 0) {
          profile.moduleCount = modules.length
          const m0 = modules[0] as Record<string, unknown>
          const speed = Number(m0['ConfiguredClockSpeed'] ?? m0['Speed'] ?? 0)
          if (Number.isFinite(speed) && speed > 0) profile.speedMhz = speed
          const smbios = Number(m0['SMBIOSMemoryType'] ?? 0)
          const typeMap: Record<number, string> = {
            24: 'DDR3',
            26: 'DDR4',
            30: 'LPDDR4',
            34: 'DDR5',
            35: 'LPDDR5',
          }
          if (smbios in typeMap) profile.memoryType = typeMap[smbios] ?? null
        }
      } catch {
        /* ignore */
      }
    }
  }

  return profile
}

function hexId(val: unknown): string | null {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return `0x${val.toString(16).padStart(4, '0')}`
  }
  if (typeof val === 'string' && val.trim()) return val.trim()
  return null
}

async function probeGpuProfile(): Promise<{
  gpus: GpuDeviceInfo[]
  gpuFeatureStatus?: Record<string, string>
}> {
  const gpus: GpuDeviceInfo[] = []
  let gpuFeatureStatus: Record<string, string> | undefined

  try {
    if (typeof app?.getGPUFeatureStatus === 'function') {
      gpuFeatureStatus = app.getGPUFeatureStatus() as unknown as Record<string, string>
    }
  } catch {
    /* ignore */
  }

  // 1) Electron Chromium GPUInfo (fast, cross-platform)
  try {
    if (typeof app?.getGPUInfo === 'function') {
      const info = (await Promise.race([
        app.getGPUInfo('complete'),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
      ])) as Record<string, unknown> | null
      const gpuDevices = Array.isArray(info?.['gpuDevice']) ? info['gpuDevice'] : []
      for (const dev of gpuDevices) {
        if (typeof dev !== 'object' || dev === null) continue
        const rec = dev as Record<string, unknown>
        const name =
          typeof rec['deviceString'] === 'string' && rec['deviceString'].trim()
            ? rec['deviceString'].trim()
            : typeof rec['vendorString'] === 'string' && rec['vendorString'].trim()
              ? rec['vendorString'].trim()
              : 'Unknown GPU'
        gpus.push({
          name,
          vendorId: hexId(rec['vendorId']),
          deviceId: hexId(rec['deviceId']),
          driverVersion:
            typeof rec['driverVersion'] === 'string' && rec['driverVersion']
              ? rec['driverVersion']
              : null,
          driverDate:
            typeof rec['driverDate'] === 'string' && rec['driverDate'] ? rec['driverDate'] : null,
          vramBytes: null,
          cores: null,
          metalSupport: null,
          active: typeof rec['active'] === 'boolean' ? rec['active'] : null,
        })
      }
    }
  } catch {
    /* ignore */
  }

  // 2) Platform-specific enrichment (Apple Silicon GPU cores + Metal / Windows 64-bit VRAM)
  if (osPlatform() === 'darwin') {
    const out = await runCommandSafe('system_profiler', ['SPDisplaysDataType', '-json'], 4000)
    if (out) {
      try {
        const parsed = JSON.parse(out) as { SPDisplaysDataType?: Array<Record<string, unknown>> }
        const displays = parsed.SPDisplaysDataType ?? []
        if (displays.length > 0) {
          const enriched: GpuDeviceInfo[] = displays.map((item, idx) => {
            const existing = gpus[idx]
            const coresRaw = Number.parseInt(String(item['sppci_cores'] ?? ''), 10)
            const vramStr = String(item['spdisplays_vram'] ?? item['spdisplays_vram_shared'] ?? '')
            let vramBytes: number | null = null
            const gbMatch = vramStr.match(/([\d.]+)\s*GB/i)
            const mbMatch = vramStr.match(/([\d.]+)\s*MB/i)
            if (gbMatch?.[1]) vramBytes = Math.round(Number(gbMatch[1]) * 1024 ** 3)
            else if (mbMatch?.[1]) vramBytes = Math.round(Number(mbMatch[1]) * 1024 ** 2)

            return {
              name:
                typeof item['sppci_model'] === 'string'
                  ? item['sppci_model']
                  : existing?.name ?? 'Apple GPU',
              vendorId: existing?.vendorId ?? (typeof item['spdisplays_vendor'] === 'string' ? item['spdisplays_vendor'] : null),
              deviceId: existing?.deviceId ?? null,
              driverVersion: existing?.driverVersion ?? null,
              driverDate: existing?.driverDate ?? null,
              vramBytes,
              cores: Number.isFinite(coresRaw) && coresRaw > 0 ? coresRaw : null,
              metalSupport:
                typeof item['spdisplays_mtlgpufamilysupport'] === 'string'
                  ? item['spdisplays_mtlgpufamilysupport']
                  : typeof item['spdisplays_metal'] === 'string'
                    ? item['spdisplays_metal']
                    : null,
              active: existing?.active ?? true,
            }
          })
          return { gpus: enriched, gpuFeatureStatus }
        }
      } catch {
        /* keep Electron GPUInfo */
      }
    }
  } else if (osPlatform() === 'win32') {
    const psScript = [
      `$ErrorActionPreference='SilentlyContinue'`,
      `$regVram = @{}`,
      `Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | ForEach-Object {`,
      `  if ($_.DriverDesc -and $_.'HardwareInformation.qwMemorySize') {`,
      `    $regVram[$_.DriverDesc] = [int64]$_.'HardwareInformation.qwMemorySize'`,
      `  }`,
      `}`,
      `@(Get-CimInstance Win32_VideoController | ForEach-Object {`,
      `  $vram = if ($regVram.ContainsKey($_.Name)) { $regVram[$_.Name] } elseif ($_.AdapterRAM -gt 0) { [int64]$_.AdapterRAM } else { $null }`,
      `  @{ Name=$_.Name; DriverVersion=$_.DriverVersion; DriverDate=if($_.DriverDate){$_.DriverDate.ToString('yyyy-MM-dd')}else{$null}; VramBytes=$vram; PNPDeviceID=$_.PNPDeviceID }`,
      `}) | ConvertTo-Json -Compress`,
    ].join('\n')

    const out = await runCommandSafe(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      PROBE_TIMEOUT_MS,
    )
    if (out) {
      try {
        const raw = JSON.parse(out.trim()) as unknown
        const items = Array.isArray(raw) ? raw : raw ? [raw] : []
        if (items.length > 0) {
          const enriched: GpuDeviceInfo[] = items.map((item, idx) => {
            const rec = item as Record<string, unknown>
            const existing = gpus[idx]
            const pnp = String(rec['PNPDeviceID'] ?? '')
            const venMatch = pnp.match(/VEN_([0-9A-F]{4})/i)
            const devMatch = pnp.match(/DEV_([0-9A-F]{4})/i)
            const vram = typeof rec['VramBytes'] === 'number' && rec['VramBytes'] > 0 ? rec['VramBytes'] : null
            return {
              name: typeof rec['Name'] === 'string' ? rec['Name'] : existing?.name ?? 'Unknown GPU',
              vendorId: venMatch?.[1] ? `0x${venMatch[1].toLowerCase()}` : existing?.vendorId ?? null,
              deviceId: devMatch?.[1] ? `0x${devMatch[1].toLowerCase()}` : existing?.deviceId ?? null,
              driverVersion:
                typeof rec['DriverVersion'] === 'string'
                  ? rec['DriverVersion']
                  : existing?.driverVersion ?? null,
              driverDate:
                typeof rec['DriverDate'] === 'string'
                  ? rec['DriverDate']
                  : existing?.driverDate ?? null,
              vramBytes: vram,
              cores: null,
              metalSupport: null,
              active: existing?.active ?? null,
            }
          })
          return { gpus: enriched, gpuFeatureStatus }
        }
      } catch {
        /* keep Electron GPUInfo */
      }
    }
  }

  return { gpus, gpuFeatureStatus }
}

interface WindowsHardwareBatchResult {
  cpu?: Record<string, unknown> | null
  memory?: Array<Record<string, unknown>>
  gpus?: Array<Record<string, unknown>>
  disks?: Record<string, Record<string, unknown>>
}

async function probeWindowsHardwareBatch(
  driveLetters: string[],
): Promise<WindowsHardwareBatchResult | null> {
  const uniqueLetters = [...new Set(driveLetters.map((l) => l.toUpperCase()).filter((l) => /^[A-Z]$/.test(l)))]
  const lettersExpr = uniqueLetters.map((l) => `'${l}'`).join(',')
  const psScript = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,L2CacheSize,L3CacheSize`,
    `$mem = @(Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity,ConfiguredClockSpeed,Speed,SMBIOSMemoryType)`,
    `$regVram = @{}`,
    `Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | ForEach-Object {`,
    `  if ($_.DriverDesc -and $_.'HardwareInformation.qwMemorySize') {`,
    `    $regVram[$_.DriverDesc] = [int64]$_.'HardwareInformation.qwMemorySize'`,
    `  }`,
    `}`,
    `$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {`,
    `  $vram = if ($regVram.ContainsKey($_.Name)) { $regVram[$_.Name] } elseif ($_.AdapterRAM -gt 0) { [int64]$_.AdapterRAM } else { $null }`,
    `  @{ Name=$_.Name; DriverVersion=$_.DriverVersion; DriverDate=if($_.DriverDate){$_.DriverDate.ToString('yyyy-MM-dd')}else{$null}; VramBytes=$vram; PNPDeviceID=$_.PNPDeviceID }`,
    `})`,
    `$disks = @{}`,
    `$physAll = @(Get-PhysicalDisk)`,
    `foreach ($dl in @(${lettersExpr})) {`,
    `  $vol = Get-Volume -DriveLetter $dl`,
    `  $part = Get-Partition -DriveLetter $dl`,
    `  $disk = if ($part) { Get-Disk -Number $part.DiskNumber } else { $null }`,
    `  $phys = if ($disk) { $physAll | Where-Object { $_.DeviceId -eq [string]$disk.Number } | Select-Object -First 1 } else { $null }`,
    `  $disks[$dl] = @{`,
    `    FileSystem = if ($vol) { $vol.FileSystem } else { $null };`,
    `    DriveType = if ($vol) { [string]$vol.DriveType } else { $null };`,
    `    BusType = if ($disk) { [string]$disk.BusType } else { $null };`,
    `    Model = if ($disk) { $disk.FriendlyName } else { $null };`,
    `    MediaType = if ($phys) { [string]$phys.MediaType } else { $null }`,
    `  }`,
    `}`,
    `@{ cpu=$cpu; memory=$mem; gpus=$gpus; disks=$disks } | ConvertTo-Json -Depth 4 -Compress`,
  ].join('\n')

  const raw = await runCommandSafe(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    6000,
  )
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>
    const toArray = (v: unknown): Array<Record<string, unknown>> =>
      Array.isArray(v)
        ? (v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null))
        : typeof v === 'object' && v !== null
          ? [v as Record<string, unknown>]
          : []
    return {
      cpu: typeof parsed['cpu'] === 'object' && parsed['cpu'] !== null ? (parsed['cpu'] as Record<string, unknown>) : null,
      memory: toArray(parsed['memory']),
      gpus: toArray(parsed['gpus']),
      disks:
        typeof parsed['disks'] === 'object' && parsed['disks'] !== null
          ? (parsed['disks'] as Record<string, Record<string, unknown>>)
          : {},
    }
  } catch {
    return null
  }
}

function parseWindowsDiskRecord(
  driveLetter: string,
  parsed: Record<string, unknown> | undefined,
): Partial<DiskProbeInfo> {
  if (!parsed) return { mountPoint: `${driveLetter}:\\` }
  const rawMedia = String(parsed['MediaType'] ?? '').toUpperCase()
  const bus = typeof parsed['BusType'] === 'string' && parsed['BusType'] ? parsed['BusType'] : null
  const driveType = String(parsed['DriveType'] ?? '')
  let mediaType: DiskProbeInfo['mediaType'] = 'Unknown'
  if (rawMedia.includes('SSD')) mediaType = 'SSD'
  else if (rawMedia.includes('HDD')) mediaType = 'HDD'
  else if (bus?.toUpperCase() === 'NVME') mediaType = 'SSD'
  else if (driveType.toLowerCase() === 'remote') mediaType = 'Network'

  const isInternal =
    bus !== null
      ? !['USB', 'SD', 'MMC', '1394', 'FILE BACKED VIRTUAL'].includes(bus.toUpperCase())
      : null

  return {
    mountPoint: `${driveLetter}:\\`,
    filesystem: typeof parsed['FileSystem'] === 'string' ? parsed['FileSystem'] : null,
    mediaType,
    busProtocol: bus,
    isInternal,
    model: typeof parsed['Model'] === 'string' ? parsed['Model'] : null,
  }
}

export async function collectSystemProfile(params: {
  deviceId: string
  deviceIdSource: DeviceIdSource
  sessionId: string
  appInstallPath: string
  userDataPath: string
  engineRuntime?: Record<string, unknown> | null
}): Promise<SystemProfileSnapshot> {
  let cpu: CpuProfileInfo
  let memory: MemoryProfileInfo
  let gpuRes: { gpus: GpuDeviceInfo[]; gpuFeatureStatus?: Record<string, string> }
  let appDisk: DiskProbeInfo
  let dataDisk: DiskProbeInfo

  if (osPlatform() === 'win32') {
    const extractDrive = (p: string): string | null => {
      const m = parsePath(p).root.match(/^([A-Za-z]):/)
      return m?.[1] ? m[1].toUpperCase() : null
    }
    const appDrive = extractDrive(params.appInstallPath)
    const dataDrive = extractDrive(params.userDataPath)
    const [batch, appSpace, dataSpace, electronGpu] = await Promise.all([
      probeWindowsHardwareBatch([appDrive, dataDrive].filter((x): x is string => x !== null)),
      probeDiskStatfs(params.appInstallPath),
      probeDiskStatfs(params.userDataPath),
      (async () => {
        const gpus: GpuDeviceInfo[] = []
        let gpuFeatureStatus: Record<string, string> | undefined
        try {
          if (typeof app?.getGPUFeatureStatus === 'function') {
            gpuFeatureStatus = app.getGPUFeatureStatus() as unknown as Record<string, string>
          }
          if (typeof app?.getGPUInfo === 'function') {
            const info = (await Promise.race([
              app.getGPUInfo('complete'),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
            ])) as Record<string, unknown> | null
            const gpuDevices = Array.isArray(info?.['gpuDevice']) ? info['gpuDevice'] : []
            for (const dev of gpuDevices) {
              if (typeof dev !== 'object' || dev === null) continue
              const rec = dev as Record<string, unknown>
              const name =
                typeof rec['deviceString'] === 'string' && rec['deviceString'].trim()
                  ? rec['deviceString'].trim()
                  : typeof rec['vendorString'] === 'string' && rec['vendorString'].trim()
                    ? rec['vendorString'].trim()
                    : 'Unknown GPU'
              gpus.push({
                name,
                vendorId: hexId(rec['vendorId']),
                deviceId: hexId(rec['deviceId']),
                driverVersion: typeof rec['driverVersion'] === 'string' && rec['driverVersion'] ? rec['driverVersion'] : null,
                driverDate: typeof rec['driverDate'] === 'string' && rec['driverDate'] ? rec['driverDate'] : null,
                vramBytes: null,
                cores: null,
                metalSupport: null,
                active: typeof rec['active'] === 'boolean' ? rec['active'] : null,
              })
            }
          }
        } catch {
          /* ignore */
        }
        return { gpus, gpuFeatureStatus }
      })(),
    ])

    const cpuList = osCpus()
    const firstCpu = cpuList[0]
    cpu = {
      model: firstCpu?.model?.trim() || 'Unknown CPU',
      arch: osArch(),
      logicalCores: cpuList.length,
      physicalCores: null,
      performanceCores: null,
      efficiencyCores: null,
      baseSpeedMhz: firstCpu?.speed && firstCpu.speed > 0 ? firstCpu.speed : null,
      maxSpeedMhz: null,
      l2CacheBytes: null,
      l3CacheBytes: null,
    }
    if (batch?.cpu) {
      if (typeof batch.cpu['Name'] === 'string' && batch.cpu['Name'].trim()) cpu.model = batch.cpu['Name'].trim()
      if (typeof batch.cpu['NumberOfCores'] === 'number') cpu.physicalCores = batch.cpu['NumberOfCores']
      if (typeof batch.cpu['NumberOfLogicalProcessors'] === 'number') cpu.logicalCores = batch.cpu['NumberOfLogicalProcessors']
      if (typeof batch.cpu['MaxClockSpeed'] === 'number' && batch.cpu['MaxClockSpeed'] > 0) cpu.maxSpeedMhz = batch.cpu['MaxClockSpeed']
      if (typeof batch.cpu['L2CacheSize'] === 'number' && batch.cpu['L2CacheSize'] > 0) cpu.l2CacheBytes = batch.cpu['L2CacheSize'] * 1024
      if (typeof batch.cpu['L3CacheSize'] === 'number' && batch.cpu['L3CacheSize'] > 0) cpu.l3CacheBytes = batch.cpu['L3CacheSize'] * 1024
    }

    const totalBytes = totalmem()
    const freeBytes = freemem()
    memory = {
      totalBytes,
      freeBytes,
      usedPercent: totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10 : 0,
      unifiedMemory: false,
      memoryType: null,
      speedMhz: null,
      moduleCount: null,
      appProcessRssBytes: getElectronAppMemoryRssBytes(),
    }
    if (batch?.memory && batch.memory.length > 0) {
      memory.moduleCount = batch.memory.length
      const m0 = batch.memory[0]
      if (m0) {
        const speed = Number(m0['ConfiguredClockSpeed'] ?? m0['Speed'] ?? 0)
        if (Number.isFinite(speed) && speed > 0) memory.speedMhz = speed
        const smbios = Number(m0['SMBIOSMemoryType'] ?? 0)
        const typeMap: Record<number, string> = { 24: 'DDR3', 26: 'DDR4', 30: 'LPDDR4', 34: 'DDR5', 35: 'LPDDR5' }
        if (smbios in typeMap) memory.memoryType = typeMap[smbios] ?? null
      }
    }

    if (batch?.gpus && batch.gpus.length > 0) {
      gpuRes = {
        gpuFeatureStatus: electronGpu.gpuFeatureStatus,
        gpus: batch.gpus.map((rec, idx) => {
          const existing = electronGpu.gpus[idx]
          const pnp = String(rec['PNPDeviceID'] ?? '')
          const venMatch = pnp.match(/VEN_([0-9A-F]{4})/i)
          const devMatch = pnp.match(/DEV_([0-9A-F]{4})/i)
          const vram = typeof rec['VramBytes'] === 'number' && rec['VramBytes'] > 0 ? rec['VramBytes'] : null
          return {
            name: typeof rec['Name'] === 'string' ? rec['Name'] : existing?.name ?? 'Unknown GPU',
            vendorId: venMatch?.[1] ? `0x${venMatch[1].toLowerCase()}` : existing?.vendorId ?? null,
            deviceId: devMatch?.[1] ? `0x${devMatch[1].toLowerCase()}` : existing?.deviceId ?? null,
            driverVersion: typeof rec['DriverVersion'] === 'string' ? rec['DriverVersion'] : existing?.driverVersion ?? null,
            driverDate: typeof rec['DriverDate'] === 'string' ? rec['DriverDate'] : existing?.driverDate ?? null,
            vramBytes: vram,
            cores: null,
            metalSupport: null,
            active: existing?.active ?? null,
          }
        }),
      }
    } else {
      gpuRes = electronGpu
    }

    const buildWinDisk = (
      role: DiskProbeInfo['role'],
      targetPath: string,
      drive: string | null,
      space: Awaited<ReturnType<typeof probeDiskStatfs>>,
    ): DiskProbeInfo => {
      const meta = drive
        ? parseWindowsDiskRecord(drive, batch?.disks?.[drive])
        : {
            mountPoint: parsePath(targetPath).root || null,
            mediaType: (targetPath.startsWith('\\\\') ? 'Network' : 'Unknown') as DiskProbeInfo['mediaType'],
          }
      return {
        role,
        mountPoint: meta.mountPoint ?? null,
        filesystem: meta.filesystem ?? null,
        mediaType: meta.mediaType ?? 'Unknown',
        busProtocol: meta.busProtocol ?? null,
        isInternal: meta.isInternal ?? null,
        model: meta.model ?? null,
        totalBytes: space.totalBytes,
        freeBytes: space.freeBytes,
        availableBytes: space.availableBytes,
        usedPercent: space.usedPercent,
      }
    }
    appDisk = buildWinDisk('app_install', params.appInstallPath, appDrive, appSpace)
    dataDisk = buildWinDisk('user_data', params.userDataPath, dataDrive, dataSpace)
  } else {
    ;[cpu, memory, gpuRes, appDisk, dataDisk] = await Promise.all([
      probeCpuProfile(),
      probeMemoryProfile(),
      probeGpuProfile(),
      probeDiskForPath('app_install', params.appInstallPath),
      probeDiskForPath('user_data', params.userDataPath),
    ])
  }

  const locale =
    typeof app?.getLocale === 'function'
      ? app.getLocale()
      : Intl.DateTimeFormat().resolvedOptions().locale
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  return {
    collectedAt: new Date().toISOString(),
    deviceId: params.deviceId,
    deviceIdSource: params.deviceIdSource,
    sessionId: params.sessionId,
    app: {
      version: typeof app?.getVersion === 'function' ? app.getVersion() : '0.0.0',
      isPackaged: typeof app?.isPackaged === 'boolean' ? app.isPackaged : false,
      electron: process.versions.electron ?? 'unknown',
      chromium: process.versions.chrome ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      v8: process.versions.v8 ?? 'unknown',
    },
    os: {
      platform: osPlatform(),
      release: osRelease(),
      version: typeof osVersion === 'function' ? osVersion() : osRelease(),
      arch: osArch(),
      locale,
      timezone,
    },
    cpu,
    memory,
    disks: [appDisk, dataDisk],
    gpus: gpuRes.gpus,
    ...(gpuRes.gpuFeatureStatus ? { gpuFeatureStatus: gpuRes.gpuFeatureStatus } : {}),
    ...(params.engineRuntime !== undefined ? { engineRuntime: params.engineRuntime } : {}),
  }
}

export function saveSystemProfileCache(
  logsDir: string,
  profile: SystemProfileSnapshot,
  deviceId?: string | null,
): void {
  try {
    const target = join(logsDir, 'system-profile.json')
    const payload = redactText(JSON.stringify(profile, null, 2), {
      deviceId: deviceId ?? profile.deviceId,
    })
    writeTextAtomicSync(target, payload, 0o600)
  } catch {
    /* non-critical */
  }
}

export function readSystemProfileCache(logsDir: string): SystemProfileSnapshot | null {
  const target = join(logsDir, 'system-profile.json')
  if (!existsSync(target)) return null
  try {
    return JSON.parse(readFileSync(target, 'utf-8')) as SystemProfileSnapshot
  } catch {
    return null
  }
}
