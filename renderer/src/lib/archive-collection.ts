/**
 * 羽迹物种墙(collection board)的派生 helpers — 把 SpeciesRecord 折叠成
 * "重点保护/濒危/常规/外类"分组,提供 UI 着色和封面图加载状态。
 */

import { useEffect, useState, type CSSProperties } from 'react'

import { getArchiveSpeciesEntries } from '@/lib/photo-display'
import type { PhotoRecord, SpeciesRecord } from '@/lib/mock-workspace'
import type { Tone } from '@/lib/photo-helpers'

type SpeciesCollectionGroupId =
  | 'protected1'
  | 'protected2'
  | 'threatened'
  | 'regular'
  | 'modelExtra'

export type SpeciesCollectionGroup = {
  id: SpeciesCollectionGroupId
  litCount: number
  species: SpeciesRecord[]
}

export type SpeciesCollectionFilter = 'all' | 'collected' | SpeciesCollectionGroupId

export type CollectionVirtualRow =
  | {
      type: 'heading'
      group: SpeciesCollectionGroup
      litCount: number
      firstGroup: boolean
    }
  | {
      type: 'cards'
      groupId: SpeciesCollectionGroupId
      species: SpeciesRecord[]
    }

const speciesCollectionGroupOrder: SpeciesCollectionGroupId[] = [
  'protected1',
  'protected2',
  'threatened',
  'regular',
  'modelExtra',
]

export function speciesCollectionGroupId(
  species: Pick<SpeciesRecord, 'protectLevel' | 'iucn' | 'inChinaV12'>,
): SpeciesCollectionGroupId {
  if (species.inChinaV12 === false) return 'modelExtra'
  const protect = species.protectLevel ?? ''
  const iucn = (species.iucn ?? '').toUpperCase()
  if (protect.includes('一级')) return 'protected1'
  if (protect.includes('二级')) return 'protected2'
  if (['NT', 'VU', 'EN', 'CR'].includes(iucn)) return 'threatened'
  return 'regular'
}

export function speciesCollectionGroupRank(groupId: SpeciesCollectionGroupId): number {
  return speciesCollectionGroupOrder.indexOf(groupId)
}

export function speciesCollectionGroupTone(groupId: SpeciesCollectionGroupId): Tone {
  if (groupId === 'protected1' || groupId === 'threatened') return 'accent'
  if (groupId === 'protected2') return 'warning'
  if (groupId === 'modelExtra') return 'muted'
  return 'neutral'
}

function speciesSortValue(species: SpeciesRecord): string {
  return `${species.name}|${species.latinName}`
}

export function buildSpeciesCollectionGroups(
  speciesRecords: SpeciesRecord[],
): SpeciesCollectionGroup[] {
  const groups = new Map<SpeciesCollectionGroupId, SpeciesRecord[]>()
  for (const species of speciesRecords) {
    const groupId = speciesCollectionGroupId(species)
    groups.set(groupId, [...(groups.get(groupId) ?? []), species])
  }

  return speciesCollectionGroupOrder.flatMap((id) => {
    const species = groups.get(id)
    if (!species || species.length === 0) return []
    return [
      {
        id,
        litCount: species.filter((item) => item.collected).length,
        species: species.toSorted((left, right) => {
          if (Boolean(left.collected) !== Boolean(right.collected)) {
            return left.collected ? -1 : 1
          }
          const scoreDiff = (right.bestScore ?? -1) - (left.bestScore ?? -1)
          if (scoreDiff !== 0) return scoreDiff
          return speciesSortValue(left).localeCompare(speciesSortValue(right), 'zh-Hans-CN')
        }),
      },
    ]
  })
}

export function photoMatchesSpecies(photo: PhotoRecord, species: SpeciesRecord): boolean {
  return getArchiveSpeciesEntries(photo).some((entry) => {
    if (entry.latinName && species.latinName) return entry.latinName === species.latinName
    return entry.name === species.name
  })
}

function cssImageUrl(url: string): string {
  return `url("${url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`
}

export function speciesArtworkStyle(
  imageUrl: string | null | undefined,
  fallbackGradient: string,
) {
  return {
    '--species-artwork-bg': imageUrl ? cssImageUrl(imageUrl) : fallbackGradient,
  } as CSSProperties
}

type SpeciesArtworkAspect = 'unknown' | 'landscape' | 'portrait' | 'square'

const speciesArtworkAspectCache = new Map<string, SpeciesArtworkAspect>()

function classifySpeciesArtworkAspect(width: number, height: number): SpeciesArtworkAspect {
  if (width <= 0 || height <= 0) return 'unknown'
  const aspect = width / height
  if (aspect >= 1.18) return 'landscape'
  if (aspect <= 0.82) return 'portrait'
  return 'square'
}

/**
 * 加载物种 hero 图判断长宽比 — 用于 archive-detail__art 容器选 landscape /
 * portrait / square 三套裁切策略。模块级 Map 缓存避免重复加载同一 URL。
 */
export function useSpeciesArtworkAspect(imageUrl: string | null | undefined): SpeciesArtworkAspect {
  const [aspect, setAspect] = useState<SpeciesArtworkAspect>(() => {
    if (!imageUrl) return 'unknown'
    return speciesArtworkAspectCache.get(imageUrl) ?? 'unknown'
  })

  useEffect(() => {
    if (!imageUrl) {
      setAspect('unknown')
      return
    }
    const cached = speciesArtworkAspectCache.get(imageUrl)
    if (cached) {
      setAspect(cached)
      return
    }
    setAspect('unknown')

    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (cancelled) return
      const next = classifySpeciesArtworkAspect(image.naturalWidth, image.naturalHeight)
      speciesArtworkAspectCache.set(imageUrl, next)
      setAspect(next)
    }
    image.onerror = () => {
      if (!cancelled) setAspect('unknown')
    }
    image.src = imageUrl

    return () => {
      cancelled = true
    }
  }, [imageUrl])

  return aspect
}
