/**
 * i18n locale consistency guard.
 *
 * Round-7: 13 个 export 相关 key 缺英文翻译被报为 Critical(英文用户看到中文按钮)。
 * 这套测试防回归 — 任何新增 zh-CN 但漏 en 翻译,或 placeholder 不一致,
 * CI 都会失败。
 */
import { describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en.json'
import zh from '@/i18n/locales/zh-CN.json'

type LocaleNode = string | { [k: string]: LocaleNode }
type LocaleObject = { [k: string]: LocaleNode }

function flattenKeys(obj: LocaleObject, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.set(key, v)
    else if (v && typeof v === 'object') {
      for (const [ck, cv] of flattenKeys(v as LocaleObject, key)) out.set(ck, cv)
    }
  }
  return out
}

function extractPlaceholders(text: string): Set<string> {
  // i18next 占位符语法:{{name}}
  const matches = text.matchAll(/\{\{(\w+)\}\}/g)
  return new Set(Array.from(matches, (m) => m[1]))
}

describe('i18n locale consistency', () => {
  const zhKeys = flattenKeys(zh as LocaleObject)
  const enKeys = flattenKeys(en as LocaleObject)

  it('every zh-CN key has an en counterpart', () => {
    const missingInEn: string[] = []
    for (const key of zhKeys.keys()) {
      if (!enKeys.has(key)) missingInEn.push(key)
    }
    expect(missingInEn, `Missing in en.json: ${missingInEn.join(', ')}`).toHaveLength(0)
  })

  it('every en key has a zh-CN counterpart', () => {
    const missingInZh: string[] = []
    for (const key of enKeys.keys()) {
      if (!zhKeys.has(key)) missingInZh.push(key)
    }
    expect(missingInZh, `Missing in zh-CN.json: ${missingInZh.join(', ')}`).toHaveLength(0)
  })

  it('placeholder sets match between zh-CN and en for shared keys', () => {
    const mismatches: string[] = []
    for (const [key, zhText] of zhKeys.entries()) {
      const enText = enKeys.get(key)
      if (enText === undefined) continue
      const zhPlaceholders = extractPlaceholders(zhText)
      const enPlaceholders = extractPlaceholders(enText)
      const missingFromEn = [...zhPlaceholders].filter((p) => !enPlaceholders.has(p))
      const missingFromZh = [...enPlaceholders].filter((p) => !zhPlaceholders.has(p))
      if (missingFromEn.length || missingFromZh.length) {
        mismatches.push(
          `${key}: en missing ${missingFromEn.join(',') || '(none)'}, zh missing ${missingFromZh.join(',') || '(none)'}`,
        )
      }
    }
    expect(mismatches, `Placeholder mismatch:\n${mismatches.join('\n')}`).toHaveLength(0)
  })
})
