/**
 * 复核弹窗的物种人工修正编辑器 — 多鸟图 bird tabs + 当前物种行 + 搜索候选 + 清除。
 *
 * 折叠状态:只展示当前物种行;展开后才出搜索框和候选列表。photo 切换时:
 *   - query 清空(避免上张照片的搜索词残留)
 *   - expanded 不重置(用户可能正在批量审核物种,展开状态在多张间持续)
 *
 * activeBirdIndex 由 ReviewModal 维护(提升后),切换鸟时左侧 bbox/pose/裁切跟随。
 *
 * v6 detection-level speciesSource:每个 detection 独立判断"待审"按钮显隐,
 * 不再被 photo-level 一刀切。
 */

import { Check, ChevronDown, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { useTranslation } from 'react-i18next'

import { SectionLabel } from '@/components/common/section-label'
import type { SpeciesOverrideBBox, SpeciesOverrideValue } from '@/lib/api-client'
import type { PhotoRecord } from '@/lib/mock-workspace'
import { listAllSpecies } from '@/lib/species-wiki'
import { cn } from '@/lib/utils'

type SpeciesOption = ReturnType<typeof listAllSpecies>[number]

export function SpeciesOverrideEditor({
  activeBirdIndex,
  onSetActiveBirdIndex,
  onSetSpeciesOverride,
  photo,
  t,
}: {
  activeBirdIndex: number
  onSetActiveBirdIndex: (index: number) => void
  onSetSpeciesOverride: (
    photoId: string,
    birdIndex: number,
    species: SpeciesOverrideValue | null,
    bbox?: SpeciesOverrideBBox | null,
  ) => void
  photo: PhotoRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  const birds = useMemo(() => {
    if (photo.birdDetections && photo.birdDetections.length > 0) {
      return photo.birdDetections
    }
    if (!photo.bestBbox) return []
    return [
      {
        index: 0,
        bbox: photo.bestBbox,
        speciesName: photo.speciesName,
        speciesLatinName: photo.speciesLatinName,
        speciesCandidates: photo.speciesCandidates,
        manualSpecies: Boolean(photo.manualSpecies),
        isBest: true,
      },
    ]
  }, [photo])
  // activeBirdIndex 由 ReviewModal 维护(提升后)— 切换鸟时左侧 bbox/pose/裁切跟随。
  // 本组件只负责 query 局部 state + 在 photo 切换时清空搜索框。
  const [query, setQuery] = useState('')
  // 默认折叠 — 用户大部分照片不需要改物种,折叠让信息密度降下来;点击当前物种行
  // 切换展开。photo 切换时不重置 expanded(用户可能正在批量审核物种,展开状态
  // 在多张间持续 OK)。
  const [expanded, setExpanded] = useState(false)
  const allSpecies = useMemo(() => listAllSpecies(), [])

  useEffect(() => {
    setQuery('')
  }, [photo.id])

  const activeBird = birds.find((bird) => bird.index === activeBirdIndex) ?? birds[0] ?? null
  const modelOptions = useMemo(() => {
    if (!activeBird) return []
    const byLatin = new Set<string>()
    const options: SpeciesOption[] = []
    for (const candidate of activeBird.speciesCandidates) {
      const latin = candidate.latinName
      if (!latin || byLatin.has(latin)) continue
      const option = allSpecies.find((item) => item.canonical_sci === latin)
      if (option) {
        options.push(option)
        byLatin.add(latin)
      }
    }
    return options
  }, [activeBird, allSpecies])

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase()
    const source = q ? allSpecies : modelOptions.length > 0 ? modelOptions : allSpecies
    const filtered = q
      ? source.filter((item) => {
          const fields = [
            item.canonical_sci,
            item.canonical_zh,
            item.canonical_en,
            item.zh_title,
            item.en_title,
            item.family_zh,
            item.family_sci,
          ]
          return fields.some((field) => field?.toLowerCase().includes(q))
        })
      : source
    return filtered.slice(0, 8)
  }, [allSpecies, modelOptions, query])

  if (!activeBird) return null

  const currentName =
    activeBird.speciesName ??
    (activeBird.speciesCandidates[0]?.name || t('selection.photo.unidentified'))
  const activeSpeciesSource = activeBird.speciesSource ?? photo.speciesSource
  const needsSpeciesReview =
    activeSpeciesSource === 'model_unconfirmed' && !activeBird.manualSpecies

  return (
    <div className={cn('species-editor', expanded && 'species-editor--expanded')}>
      <div className="species-editor__head">
        <SectionLabel label={t('selection.review.species')} />
        {activeBird.manualSpecies ? (
          <span className="species-editor__manual">{t('selection.speciesEditor.manual')}</span>
        ) : null}
      </div>

      {/* 多鸟图 bird tabs 在折叠头里 — 不展开就能切鸟,看不同 detection 的物种。
          切鸟按钮 stopPropagation 阻止冒泡到外层折叠 toggle。 */}
      {birds.length > 1 ? (
        <div className="species-editor__birds" role="tablist">
          {birds.map((bird) => (
            <button
              className={cn(
                'species-editor__bird',
                bird.index === activeBird.index && 'species-editor__bird--active',
              )}
              key={`${photo.id}-bird-${bird.index}`}
              onClick={(event) => {
                event.stopPropagation()
                onSetActiveBirdIndex(bird.index)
              }}
              type="button"
            >
              {t('selection.speciesEditor.bird')} {bird.index + 1}
            </button>
          ))}
        </div>
      ) : null}

      {/* 当前物种单行 + 展开切换 button — 默认折叠状态只展示这一行;
          点击切换 expanded。 */}
      <button
        aria-expanded={expanded}
        className="species-editor__current species-editor__current--toggle"
        onClick={() => setExpanded((v) => !v)}
        type="button"
      >
        <span>
          <strong>{currentName}</strong>
          <small>{activeBird.speciesLatinName ?? t('selection.speciesEditor.noLatin')}</small>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn('species-editor__chevron', expanded && 'species-editor__chevron--open')}
        />
      </button>
      {needsSpeciesReview ? (
        <div className="species-editor__review-note" role="note">
          {t(
            expanded
              ? 'selection.speciesEditor.reviewHintExpanded'
              : 'selection.speciesEditor.reviewHintCollapsed',
          )}
        </div>
      ) : null}

      {/* 折叠状态:以上头部 + 当前物种行就够;展开才显示候选/搜索/清除。
          按 activeBird.speciesSource 判断(v6 detection-level)— 多鸟图混合可见性
          下,每个 detection 独立判断按钮显隐,不被 photo-level 一刀切。 */}
      {expanded ? (
        <>
          {needsSpeciesReview && activeBird.speciesLatinName ? (
            <button
              className="species-editor__confirm"
              onClick={() =>
                onSetSpeciesOverride(
                  photo.id,
                  activeBird.index,
                  {
                    canonical_sci: activeBird.speciesLatinName!,
                    canonical_zh: activeBird.speciesName ?? null,
                    canonical_en: activeBird.speciesEnglishName ?? null,
                  },
                  activeBird.bbox
                    ? {
                        x1: activeBird.bbox.x1,
                        y1: activeBird.bbox.y1,
                        x2: activeBird.bbox.x2,
                        y2: activeBird.bbox.y2,
                      }
                    : null,
                )
              }
              title={t('selection.speciesEditor.confirmModelHint')}
              type="button"
            >
              <Check className="h-3.5 w-3.5" />
              {t('selection.speciesEditor.confirmModel')}
            </button>
          ) : null}

          <div className="species-editor__search">
            <Search className="h-3.5 w-3.5" />
            <input
              aria-label={t('selection.speciesEditor.search')}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('selection.speciesEditor.search')}
              value={query}
            />
          </div>

          <div className="species-editor__options">
            {filteredOptions.map((option) => {
              const label = option.canonical_zh ?? option.canonical_en ?? option.canonical_sci
              const isCurrent = option.canonical_sci === activeBird.speciesLatinName
              return (
                <button
                  className={cn(
                    'species-editor__option',
                    isCurrent && 'species-editor__option--active',
                  )}
                  key={`${photo.id}-${activeBird.index}-${option.canonical_sci}`}
                  onClick={() => {
                    onSetSpeciesOverride(
                      photo.id,
                      activeBird.index,
                      {
                        canonical_sci: option.canonical_sci,
                        canonical_zh: option.canonical_zh,
                        canonical_en: option.canonical_en,
                      },
                      activeBird.bbox
                        ? {
                            x1: activeBird.bbox.x1,
                            y1: activeBird.bbox.y1,
                            x2: activeBird.bbox.x2,
                            y2: activeBird.bbox.y2,
                          }
                        : null,
                    )
                    setQuery('')
                  }}
                  type="button"
                >
                  <span>
                    <strong>{label}</strong>
                    <small>{option.canonical_sci}</small>
                  </span>
                  <b>
                    {option.is_trained
                      ? t('selection.speciesEditor.auto')
                      : t('selection.speciesEditor.manualOnly')}
                  </b>
                </button>
              )
            })}
          </div>

          <button
            className="species-editor__clear"
            disabled={!activeBird.manualSpecies}
            onClick={() =>
              onSetSpeciesOverride(
                photo.id,
                activeBird.index,
                null,
                activeBird.bbox
                  ? {
                      x1: activeBird.bbox.x1,
                      y1: activeBird.bbox.y1,
                      x2: activeBird.bbox.x2,
                      y2: activeBird.bbox.y2,
                    }
                  : null,
              )
            }
            type="button"
          >
            {t('selection.speciesEditor.clear')}
          </button>
        </>
      ) : null}
    </div>
  )
}
