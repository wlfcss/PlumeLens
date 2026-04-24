/**
 * Local bundled species Wikipedia summaries.
 *
 * 数据源：engine/models/species_wiki.parquet（由 scripts/fetch_species_wiki.py 爬取），
 * 由 scripts/build_species_wiki_json.py 导出为 `species-wiki.json`，
 * 直接 import 进 renderer bundle，无需后端 API。
 *
 * 1516 种中国鸟类，覆盖率 zh 99.3% / en 99.9%。
 */
// Vite 支持 JSON 直接 import；tsconfig.web.json 已开 resolveJsonModule
import data from './species-wiki.json'

export interface SpeciesWiki {
  zh_title: string | null
  zh_extract: string | null
  zh_url: string | null
  en_title: string | null
  en_extract: string | null
  en_url: string | null
  image_url: string | null
}

/** Index type-safe. Real JSON may have fewer entries than 1516 if some miss. */
const INDEX = data as Record<string, SpeciesWiki>

/**
 * Look up Wikipedia summary for a species.
 *
 * @param canonicalSci 拉丁学名（与 species_taxonomy 一致）
 * @returns SpeciesWiki | undefined  when no entry
 */
export function getSpeciesWiki(canonicalSci: string): SpeciesWiki | undefined {
  return INDEX[canonicalSci]
}

/** Does the local cache know about this species? */
export function hasSpeciesWiki(canonicalSci: string): boolean {
  return canonicalSci in INDEX
}

/** Total number of species in the local cache. */
export function speciesWikiCount(): number {
  return Object.keys(INDEX).length
}

/**
 * Produce a display-ready summary preferring Chinese, falling back to English.
 * Returns null if neither is available.
 */
export function preferredExtract(
  canonicalSci: string,
): { text: string; lang: 'zh' | 'en' } | null {
  const entry = getSpeciesWiki(canonicalSci)
  if (!entry) return null
  if (entry.zh_extract) return { text: entry.zh_extract, lang: 'zh' }
  if (entry.en_extract) return { text: entry.en_extract, lang: 'en' }
  return null
}
