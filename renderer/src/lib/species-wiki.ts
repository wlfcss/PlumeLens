/**
 * Local bundled species catalog + lazy-loaded Wikipedia body summaries.
 *
 * 数据源：engine/models/species_wiki.parquet（由 scripts/fetch_species_wiki.py 爬取），
 * 由 scripts/build_species_wiki_json.py 拆分为两份 JSON：
 *   - `species-catalog.json`（~459 KB）：轻量分类元数据、别名、训练与名录标记，随主包同步加载。
 *   - `species-wiki-bodies.json`（~1.87 MB）：中/英维基百科正文与来源链接，仅在打开物种详情
 *     弹窗或羽迹详情面板时通过 dynamic import 按需拆包加载。
 *
 * 收录范围：species v4 canonical_extended 全部 1591 种。
 *   - `is_trained = true`：DINOv4 分类模型可自动识别
 *   - `is_trained = false`：legacy taxonomy 下训练样本不足，**仅支持用户手动标注**
 */
import { useEffect, useState } from 'react'

import catalogData from './species-catalog.json'

export interface SpeciesCatalogMeta {
  canonical_zh: string | null
  canonical_en: string | null
  family_sci: string | null
  family_zh: string | null
  order_sci: string | null
  iucn: string | null
  protect_level: string | null
  zh_title: string | null
  en_title: string | null
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

export interface SpeciesWikiBody {
  zh_extract: string | null
  zh_url: string | null
  en_extract: string | null
  en_url: string | null
}

export interface SpeciesWiki extends SpeciesCatalogMeta {
  zh_extract: string | null
  zh_url: string | null
  en_extract: string | null
  en_url: string | null
}

const CATALOG = catalogData as Record<string, SpeciesCatalogMeta>

export type SpeciesCatalogEntry = { canonical_sci: string } & SpeciesCatalogMeta

let aliasIndex: Map<string, string> | null = null
let cachedAllSpecies: SpeciesCatalogEntry[] | null = null
let bodiesCache: Record<string, SpeciesWikiBody> | null = null
let bodiesPromise: Promise<Record<string, SpeciesWikiBody>> | null = null

const EMPTY_BODY: SpeciesWikiBody = {
  zh_extract: null,
  zh_url: null,
  en_extract: null,
  en_url: null,
}

export function normalizeSpeciesAlias(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, ' ')
  return normalized ? normalized : null
}

/** Lazily load the split Wikipedia bodies chunk (singleton cached). */
export function loadSpeciesWikiBodies(): Promise<Record<string, SpeciesWikiBody>> {
  if (bodiesCache) return Promise.resolve(bodiesCache)
  if (!bodiesPromise) {
    bodiesPromise = import('./species-wiki-bodies.json')
      .then((mod) => {
        const loaded = (mod.default ?? mod) as Record<string, SpeciesWikiBody>
        bodiesCache = loaded
        return loaded
      })
      .catch((error) => {
        bodiesPromise = null
        throw error
      })
  }
  return bodiesPromise
}

/** Synchronously read a loaded wiki body if the lazy chunk is already cached. */
export function getLoadedSpeciesWikiBody(canonicalSci: string): SpeciesWikiBody | undefined {
  return bodiesCache?.[canonicalSci]
}

/** React hook to lazily load a species' Wikipedia extract and URLs on demand. */
export function useSpeciesWikiBody(canonicalSci: string | null | undefined): {
  body: SpeciesWikiBody | null
  loading: boolean
} {
  const [loadedMap, setLoadedMap] = useState<Record<string, SpeciesWikiBody> | null>(
    () => bodiesCache,
  )
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!canonicalSci) return
    if (bodiesCache) {
      if (loadedMap !== bodiesCache) setLoadedMap(bodiesCache)
      return
    }
    let cancelled = false
    setFailed(false)
    void loadSpeciesWikiBodies()
      .then((map) => {
        if (!cancelled) setLoadedMap(map)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [canonicalSci, loadedMap])

  if (!canonicalSci) return { body: null, loading: false }
  if (loadedMap) return { body: loadedMap[canonicalSci] ?? null, loading: false }
  return { body: null, loading: !failed }
}

/** Look up species metadata (and Wikipedia body if the lazy chunk is already loaded). */
export function getSpeciesWiki(canonicalSci: string): SpeciesWiki | undefined {
  const meta = CATALOG[canonicalSci]
  if (!meta) return undefined
  const body = bodiesCache?.[canonicalSci] ?? EMPTY_BODY
  return { ...meta, ...body }
}

/** Does the local catalog know about this species? */
export function hasSpeciesWiki(canonicalSci: string): boolean {
  return canonicalSci in CATALOG
}

/** Total number of species in the local catalog (1591 for species v4). */
export function speciesWikiCount(): number {
  return Object.keys(CATALOG).length
}

/**
 * Is this species automatically recognisable by the DINOv4 classifier?
 * Returns `false` for both untrained species and completely unknown names.
 */
export function isAutoRecognisable(canonicalSci: string): boolean {
  return CATALOG[canonicalSci]?.is_trained === true
}

/**
 * Return all species as a flat array (for picker/search UI in manual tagging).
 * Cached because the bundled catalog is immutable at runtime.
 */
export function listAllSpecies(): SpeciesCatalogEntry[] {
  if (!cachedAllSpecies) {
    cachedAllSpecies = Object.entries(CATALOG)
      .map(([canonical_sci, v]) => ({ canonical_sci, ...v }))
      .sort((a, b) => {
        const left = a.canonical_zh ?? a.canonical_en ?? a.canonical_sci
        const right = b.canonical_zh ?? b.canonical_en ?? b.canonical_sci
        return left.localeCompare(right, 'zh-Hans-CN')
      })
  }
  return cachedAllSpecies
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

  for (const [canonicalSci, entry] of Object.entries(CATALOG)) {
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
 * Returns null if neither is available or bodies have not been loaded yet.
 */
export function preferredExtract(canonicalSci: string): { text: string; lang: 'zh' | 'en' } | null {
  const body = bodiesCache?.[canonicalSci]
  if (!body) return null
  if (body.zh_extract) return { text: body.zh_extract, lang: 'zh' }
  if (body.en_extract) return { text: body.en_extract, lang: 'en' }
  return null
}
