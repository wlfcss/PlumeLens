/**
 * Local bundled species Wikipedia summaries + auto-recognition flag.
 *
 * 数据源：engine/models/species_wiki.parquet（由 scripts/fetch_species_wiki.py 爬取），
 * 由 scripts/build_species_wiki_json.py 导出为 `species-wiki.json`。
 *
 * 收录范围：《中国鸟类名录 v12.0》全部 1516 种。
 *   - `is_trained = true`（1018 种）：DINOv3 分类模型可自动识别
 *   - `is_trained = false`（498 种）：训练样本不足，**仅支持用户手动标注**
 *     （manual 挑选物种时仍需展示介绍，因此也打包进来）
 *
 * Wikipedia 覆盖率 zh 99.3% / en 99.9%（个别稀有种可能都没有 extract）。
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
  /**
   * True  → 分类模型可自动识别此物种
   * False → 仅支持用户手动归类（自动识别时不会输出）
   */
  is_trained: boolean
}

const INDEX = data as Record<string, SpeciesWiki>

/** Look up Wikipedia summary for a species. */
export function getSpeciesWiki(canonicalSci: string): SpeciesWiki | undefined {
  return INDEX[canonicalSci]
}

/** Does the local cache know about this species? */
export function hasSpeciesWiki(canonicalSci: string): boolean {
  return canonicalSci in INDEX
}

/** Total number of species in the local cache (should be 1516). */
export function speciesWikiCount(): number {
  return Object.keys(INDEX).length
}

/**
 * Is this species automatically recognisable by the DINOv3 classifier?
 * Returns `false` for both untrained species and completely unknown names.
 */
export function isAutoRecognisable(canonicalSci: string): boolean {
  return INDEX[canonicalSci]?.is_trained === true
}

/**
 * Return all species as a flat array (for picker/search UI in manual tagging).
 * Sorted by canonical_sci.
 */
export function listAllSpecies(): Array<{ canonical_sci: string } & SpeciesWiki> {
  return Object.entries(INDEX)
    .map(([canonical_sci, v]) => ({ canonical_sci, ...v }))
    .sort((a, b) => a.canonical_sci.localeCompare(b.canonical_sci))
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
