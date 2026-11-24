import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockState, safeStorageMock } = vi.hoisted(() => ({
  mockState: { userDataDir: '' },
  safeStorageMock: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((text: string) => Buffer.from(`sync:${text}`, 'utf-8')),
    decryptString: vi.fn((buf: Buffer) => buf.toString('utf-8').replace(/^sync:/, '')),
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async (text: string) => Buffer.from(`async:${text}`, 'utf-8')),
    decryptStringAsync: vi.fn(async (buf: Buffer) => {
      const raw = buf.toString('utf-8')
      if (raw === 'corrupt') throw new Error('bad keychain item')
      if (raw.startsWith('legacy-enc:')) {
        return { result: raw.replace(/^legacy-enc:/, ''), shouldReEncrypt: true }
      }
      return { result: raw.replace(/^async:/, ''), shouldReEncrypt: false }
    }),
  },
}))

vi.mock('electron', () => ({
  app: { getPath: () => mockState.userDataDir },
  safeStorage: safeStorageMock,
}))

import { mergeUserSettings, readUserSettings, writeUserSettings } from '../../electron/user-settings'

beforeEach(() => {
  mockState.userDataDir = mkdtempSync(join(tmpdir(), 'plumelens-settings-test-'))
  vi.clearAllMocks()
})

afterEach(() => {
  if (mockState.userDataDir) rmSync(mockState.userDataDir, { recursive: true, force: true })
})

describe('user-settings async safeStorage (Electron 45+)', () => {
  it('encrypts and decrypts via async safeStorage APIs', async () => {
    await writeUserSettings({ amapKey: 'secret-amap' })
    const raw = JSON.parse(readFileSync(join(mockState.userDataDir, 'settings.json'), 'utf-8'))
    expect(raw.amapKey).toEqual({
      enc: Buffer.from('async:secret-amap', 'utf-8').toString('base64'),
    })
    expect(safeStorageMock.encryptStringAsync).toHaveBeenCalledWith('secret-amap')

    const readBack = await readUserSettings()
    expect(readBack).toEqual({ amapKey: 'secret-amap' })
    expect(safeStorageMock.decryptStringAsync).toHaveBeenCalledOnce()
  })

  it('re-encrypts on read when safeStorage reports shouldReEncrypt=true', async () => {
    writeFileSync(
      join(mockState.userDataDir, 'settings.json'),
      JSON.stringify({
        baiduAk: { enc: Buffer.from('legacy-enc:ak-123', 'utf-8').toString('base64') },
      }),
      'utf-8',
    )
    const readBack = await readUserSettings()
    expect(readBack).toEqual({ baiduAk: 'ak-123' })
    const rewritten = JSON.parse(
      readFileSync(join(mockState.userDataDir, 'settings.json'), 'utf-8'),
    )
    expect(rewritten.baiduAk).toEqual({
      enc: Buffer.from('async:ak-123', 'utf-8').toString('base64'),
    })
  })

  it('preserves untouched undecryptable fields during mergeUserSettings', async () => {
    const corruptEnc = Buffer.from('corrupt', 'utf-8').toString('base64')
    writeFileSync(
      join(mockState.userDataDir, 'settings.json'),
      JSON.stringify({ tencentKey: { enc: corruptEnc } }),
      'utf-8',
    )
    const merged = await mergeUserSettings({ amapKey: 'new-amap' })
    expect(merged).toEqual({ amapKey: 'new-amap' })
    const onDisk = JSON.parse(readFileSync(join(mockState.userDataDir, 'settings.json'), 'utf-8'))
    expect(onDisk.tencentKey).toEqual({ enc: corruptEnc })
    expect(onDisk.amapKey).toEqual({
      enc: Buffer.from('async:new-amap', 'utf-8').toString('base64'),
    })
  })
})
