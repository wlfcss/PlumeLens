/**
 * Minimal, dependency-free standard ZIP archive builder using Node's built-in `zlib`.
 *
 * Supports UTF-8 filenames (general purpose bit 11) and Deflate compression
 * (method 8, falling back to Store method 0 for empty/tiny payloads).
 * Compatible with macOS Archive Utility, Windows Explorer, and Python `zipfile`.
 */

import { promisify } from 'util'
import * as zlib from 'zlib'

const deflateRawAsync = promisify(zlib.deflateRaw)
const nativeCrc32: ((data: Buffer) => number) | null =
  typeof (zlib as unknown as { crc32?: (data: Buffer) => number }).crc32 === 'function'
    ? (zlib as unknown as { crc32: (data: Buffer) => number }).crc32
    : null

export interface ZipEntryInput {
  /** Forward-slash relative path inside the archive (e.g. `logs/client.jsonl`). */
  name: string
  data: Buffer | string
  mtime?: Date
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(buffer: Buffer): number {
  if (nativeCrc32) return nativeCrc32(buffer) >>> 0
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i] ?? 0
    const entry = CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0
    crc = entry ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function toDosTimeDate(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const seconds = Math.floor(date.getSeconds() / 2)
  const dosTime = (hours << 11) | (minutes << 5) | seconds
  const dosDate = ((year - 1980) << 9) | (month << 5) | day
  return { dosTime, dosDate }
}

export function buildZipArchive(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const normalizedName = entry.name.replace(/\\/g, '/').replace(/^\/+/, '')
    const nameBuf = Buffer.from(normalizedName, 'utf-8')
    const rawBuf = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf-8') : entry.data
    const checksum = crc32(rawBuf)
    const { dosTime, dosDate } = toDosTimeDate(entry.mtime ?? new Date())

    let method = 0
    let payload = rawBuf
    if (rawBuf.length >= 64) {
      const deflated = zlib.deflateRawSync(rawBuf, { level: 6 })
      if (deflated.length < rawBuf.length) {
        method = 8
        payload = deflated
      }
    }

    // Local File Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0) // signature
    localHeader.writeUInt16LE(20, 4) // version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6) // UTF-8 flag
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(dosTime, 10)
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(payload.length, 18)
    localHeader.writeUInt32LE(rawBuf.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28) // extra length

    localParts.push(localHeader, nameBuf, payload)

    // Central Directory Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0) // signature
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(0x0800, 8) // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(dosTime, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(payload.length, 20)
    centralHeader.writeUInt32LE(rawBuf.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra length
    centralHeader.writeUInt16LE(0, 32) // comment length
    centralHeader.writeUInt16LE(0, 34) // disk number start
    centralHeader.writeUInt16LE(0, 36) // internal attrs
    centralHeader.writeUInt32LE(0, 38) // external attrs
    centralHeader.writeUInt32LE(offset, 42) // local header offset

    centralParts.push(centralHeader, nameBuf)
    offset += localHeader.length + nameBuf.length + payload.length
  }

  const centralDirBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // EOCD signature
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // disk with central dir
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localParts, centralDirBuf, eocd])
}

/**
 * Async ZIP builder: offloads Deflate compression to libuv's C++ thread pool
 * and uses native `zlib.crc32` so large diagnostics bundles never stall the
 * Electron main event loop.
 */
export async function buildZipArchiveAsync(entries: ZipEntryInput[]): Promise<Buffer> {
  const prepared = await Promise.all(
    entries.map(async (entry) => {
      const normalizedName = entry.name.replace(/\\/g, '/').replace(/^\/+/, '')
      const nameBuf = Buffer.from(normalizedName, 'utf-8')
      const rawBuf = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf-8') : entry.data
      const checksum = crc32(rawBuf)
      const { dosTime, dosDate } = toDosTimeDate(entry.mtime ?? new Date())

      let method = 0
      let payload = rawBuf
      if (rawBuf.length >= 64) {
        const deflated = await deflateRawAsync(rawBuf, { level: 6 })
        if (deflated.length < rawBuf.length) {
          method = 8
          payload = deflated
        }
      }
      return { nameBuf, rawBuf, checksum, dosTime, dosDate, method, payload }
    }),
  )

  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const item of prepared) {
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(item.method, 8)
    localHeader.writeUInt16LE(item.dosTime, 10)
    localHeader.writeUInt16LE(item.dosDate, 12)
    localHeader.writeUInt32LE(item.checksum, 14)
    localHeader.writeUInt32LE(item.payload.length, 18)
    localHeader.writeUInt32LE(item.rawBuf.length, 22)
    localHeader.writeUInt16LE(item.nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localParts.push(localHeader, item.nameBuf, item.payload)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(item.method, 10)
    centralHeader.writeUInt16LE(item.dosTime, 12)
    centralHeader.writeUInt16LE(item.dosDate, 14)
    centralHeader.writeUInt32LE(item.checksum, 16)
    centralHeader.writeUInt32LE(item.payload.length, 20)
    centralHeader.writeUInt32LE(item.rawBuf.length, 24)
    centralHeader.writeUInt16LE(item.nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)

    centralParts.push(centralHeader, item.nameBuf)
    offset += localHeader.length + item.nameBuf.length + item.payload.length
  }

  const centralDirBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(prepared.length, 8)
  eocd.writeUInt16LE(prepared.length, 10)
  eocd.writeUInt32LE(centralDirBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDirBuf, eocd])
}
