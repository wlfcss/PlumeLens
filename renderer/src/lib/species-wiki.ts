/**
 * Local bundled species Wikipedia summaries + auto-recognition flag.
 *
 * 数据源：engine/models/species_wiki.parquet（由 scripts/fetch_species_wiki.py 爬取），
 * 由 scripts/build_species_wiki_json.py 导出为 `species-wiki.json`。
 *
 * 收录范围：species v4 canonical_extended 全部 1591 种。
 *   - `is_trained = true`：DINOv3 分类模型可自动识别
 *   - `is_trained = false`：legacy taxonomy 下训练样本不足，**仅支持用户手动标注**
 *
 * Wikipedia 覆盖率 zh 99.3% / en 99.9%（个别稀有种可能都没有 extract）。
 */
// Vite 支持 JSON 直接 import；tsconfig.web.json 已开 resolveJsonModule
import data from './species-wiki.json'

export interface SpeciesWiki {
  canonical_zh: string | null
  canonical_en: string | null
  family_sci: string | null
  family_zh: string | null
  order_sci: string | null
  iucn: string | null
  protect_level: string | null
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
  /**
   * True  → 中国观鸟年报 v12.0 主名录物种
 * False → v4 class map 中 `scope=extra` 的非 v12.0 增补物种
   */
  in_china_v12: boolean
}

const INDEX = data as Record<string, SpeciesWiki>

export type SpeciesCatalogEntry = { canonical_sci: string } & SpeciesWiki

let aliasIndex: Map<string, string> | null = null

export function normalizeSpeciesAlias(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, ' ')
  return normalized ? normalized : null
}

/** Look up Wikipedia summary for a species. */
export function getSpeciesWiki(canonicalSci: string): SpeciesWiki | undefined {
  return INDEX[canonicalSci]
}

/** Does the local cache know about this species? */
export function hasSpeciesWiki(canonicalSci: string): boolean {
  return canonicalSci in INDEX
}

/** Total number of species in the local cache (1591 for species v4). */
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
export function listAllSpecies(): SpeciesCatalogEntry[] {
  return Object.entries(INDEX)
    .map(([canonical_sci, v]) => ({ canonical_sci, ...v }))
    .sort((a, b) => {
      const left = a.canonical_zh ?? a.canonical_en ?? a.canonical_sci
      const right = b.canonical_zh ?? b.canonical_en ?? b.canonical_sci
      return left.localeCompare(right, 'zh-Hans-CN')
    })
}

function buildAliasIndex(): Map<string, string> {
  const aliases = new Map<string, string>()
  const weakAliases = new Map<string, Set<string>>()

  const bind = (alias: string | null | undefined, canonicalSci: string) => {
    const normalized = normalizeSpeciesAlias(alias)
    if (normalized) aliases.set(normalized, canonicalSci)
  }
  const bindWeak = (alias: string | null | undefined, canonicalSci: string) => {
    const normalized = normalizeSpeciesAlias(alias)
    if (!normalized) return
    const set = weakAliases.get(normalized) ?? new Set<string>()
    set.add(canonicalSci)
    weakAliases.set(normalized, set)
  }

  for (const [canonicalSci, entry] of Object.entries(INDEX)) {
    bind(canonicalSci, canonicalSci)
    bind(entry.canonical_zh, canonicalSci)
    bind(entry.canonical_en, canonicalSci)
    bindWeak(entry.zh_title, canonicalSci)
    bindWeak(entry.en_title, canonicalSci)
  }

  for (const [alias, species] of weakAliases.entries()) {
    if (aliases.has(alias) || species.size !== 1) continue
    aliases.set(alias, Array.from(species)[0])
  }

  return aliases
}

/**
 * Resolve a user/backend supplied species name to the canonical scientific name.
 *
 * Identity is anchored on v12/model canonical fields. Wikipedia titles are only
 * accepted when they are unique, so ambiguous old names never light up the
 * wrong achievement card.
 */
export function resolveSpeciesCanonicalSci(alias: string | null | undefined): string | null {
  const normalized = normalizeSpeciesAlias(alias)
  if (!normalized) return null
  aliasIndex ??= buildAliasIndex()
  return aliasIndex.get(normalized) ?? null
}

/**
 * Produce a display-ready summary preferring Chinese, falling back to English.
 * Returns null if neither is available.
 */
export function preferredExtract(canonicalSci: string): { text: string; lang: 'zh' | 'en' } | null {
  const entry = getSpeciesWiki(canonicalSci)
  if (!entry) return null
  if (entry.zh_extract) return { text: entry.zh_extract, lang: 'zh' }
  if (entry.en_extract) return { text: entry.en_extract, lang: 'en' }
  return null
}
