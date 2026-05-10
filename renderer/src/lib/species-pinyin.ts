import { customPinyin, pinyin } from 'pinyin-pro'

customPinyin({
  䳭: 'jí',
  石䳭: 'shí jí',
  东亚石䳭: 'dōng yà shí jí',
})

const pinyinCache = new Map<string, string | null>()

export function formatSpeciesPinyin(name: string | null | undefined): string | null {
  const trimmed = name?.trim()
  if (!trimmed) return null

  const cached = pinyinCache.get(trimmed)
  if (cached !== undefined) return cached

  try {
    const value = pinyin(trimmed, {
      nonZh: 'removed',
      toneType: 'symbol',
      type: 'array',
    })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    const result = value.length > 0 ? value : null
    pinyinCache.set(trimmed, result)
    return result
  } catch {
    pinyinCache.set(trimmed, null)
    return null
  }
}
