/**
 * 羽迹页 — 物种墙 (collection board) + 地理分布 (ECharts 三级穿透) 两个 Tab。
 *
 * 历史:之前住在 App.tsx,本次随大 refactor 外迁。物种墙是虚拟滚动 + 响应式
 * 网格,1591 种全部渲染时性能压力主要在这里。
 */

import { Shield, Trophy, X } from 'lucide-react'
import {
  Suspense,
  lazy,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'

import { IconButton } from '@/components/common/icon-button'
import { SectionLabel } from '@/components/common/section-label'
import { StatRow } from '@/components/common/stat-row'
import { StatusPill } from '@/components/common/status-pill'
import { ThumbnailImage } from '@/components/thumbnail-image'
import {
  buildSpeciesCollectionGroups,
  photoMatchesSpecies,
  speciesArtworkStyle,
  speciesCollectionGroupId,
  speciesCollectionGroupTone,
  useSpeciesArtworkAspect,
  type CollectionVirtualRow,
  type SpeciesCollectionFilter,
  type SpeciesCollectionGroup,
} from '@/lib/archive-collection'
import { openExternalLink } from '@/lib/external-link'
import { archiveTabLabelKey } from '@/lib/i18n-keys'
import type {
  ArchiveTab,
  PhotoRecord,
  SpeciesRecord,
} from '@/lib/mock-workspace'
import { formatRatio, formatScore, type Tone } from '@/lib/photo-helpers'
import { formatSpeciesPinyin } from '@/lib/species-pinyin'
import { getSpeciesWiki } from '@/lib/species-wiki'
import { cn } from '@/lib/utils'
import {
  useResponsiveGridLayout,
  virtualGridStyle,
} from '@/lib/virtual-grid'

const ArchiveGeoMap = lazy(() =>
  import('@/components/archive-geo-map').then((module) => ({ default: module.ArchiveGeoMap })),
)

const archiveTabs: ArchiveTab[] = ['species', 'map']

const COLLECTION_GRID_MIN_COLUMN_WIDTH = 150
const COLLECTION_GRID_GAP = 8
const COLLECTION_HEADING_ESTIMATED_HEIGHT = 52
const COLLECTION_CARD_ROW_ESTIMATED_HEIGHT = 204

// memo:1591 个物种卡虚拟滚动时同一 species 引用稳定,memo 防止滚动期间
// 不在 viewport 的卡片重渲染。
const CollectionSpeciesCard = memo(function CollectionSpeciesCard({
  active,
  onSelectSpecies,
  species,
  t,
}: {
  active: boolean
  onSelectSpecies: (speciesId: string | null) => void
  species: SpeciesRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  const pinyinText = formatSpeciesPinyin(species.name)
  return (
    <button
      className={cn(
        'collection-card',
        species.collected ? 'collection-card--lit' : 'collection-card--locked',
        !species.imageUrl && 'collection-card--empty-art',
        active && 'collection-card--active',
      )}
      onClick={() => onSelectSpecies(species.id)}
      style={speciesArtworkStyle(species.imageUrl, species.coverGradient)}
      type="button"
    >
      <span className="collection-card__signal">
        {species.collected ? <Trophy className="h-3.5 w-3.5" /> : <span aria-hidden="true" />}
        {species.collected ? t('archive.collection.collected') : t('archive.collection.locked')}
      </span>
      <strong
        title={
          pinyinText ? t('speciesDetail.tooltipWithPinyin', { pinyin: pinyinText }) : undefined
        }
      >
        {species.name}
      </strong>
      <small>{species.latinName}</small>
      <span className="collection-card__meta">
        <span>{species.familyName ?? t('archive.collection.unknownFamily')}</span>
        <b>
          {species.collected
            ? t('archive.collection.photoCount', { count: species.photoCount })
            : species.catalogSource === 'model_extra'
              ? t('archive.collection.modelExtraBadge')
              : (species.protectLevel ?? species.iucn ?? '--')}
        </b>
      </span>
    </button>
  )
})

function VirtualizedCollectionBoard({
  activeSpeciesId,
  groups,
  onSelectSpecies,
  scrollRef,
  t,
}: {
  activeSpeciesId: string | null
  groups: SpeciesCollectionGroup[]
  onSelectSpecies: (speciesId: string | null) => void
  scrollRef: RefObject<HTMLElement | null>
  t: ReturnType<typeof useTranslation>['t']
}) {
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null)
  const gridLayout = useResponsiveGridLayout(
    containerElement,
    COLLECTION_GRID_MIN_COLUMN_WIDTH,
    COLLECTION_GRID_GAP,
  )
  const columns = gridLayout.columns
  const rows = useMemo<CollectionVirtualRow[]>(() => {
    const nextRows: CollectionVirtualRow[] = []
    groups.forEach((group, groupIndex) => {
      nextRows.push({
        type: 'heading',
        group,
        litCount: group.litCount,
        firstGroup: groupIndex === 0,
      })
      for (let start = 0; start < group.species.length; start += columns) {
        nextRows.push({
          type: 'cards',
          groupId: group.id,
          species: group.species.slice(start, start + columns),
        })
      }
    })
    return nextRows
  }, [columns, groups])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      rows[index]?.type === 'heading'
        ? COLLECTION_HEADING_ESTIMATED_HEIGHT
        : COLLECTION_CARD_ROW_ESTIMATED_HEIGHT,
    overscan: 7,
  })

  if (groups.length === 0) return null

  return (
    <div className="collection-virtual-board" ref={setContainerElement}>
      <div
        className="collection-virtual-board__spacer"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index]
          if (!row) return null
          return (
            <div
              className={cn(
                'collection-virtual-row',
                row.type === 'heading' && 'collection-virtual-row--heading',
                row.type === 'heading' && row.firstGroup && 'collection-virtual-row--first',
              )}
              data-index={virtualRow.index}
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {row.type === 'heading' ? (
                <div className="collection-section__heading">
                  <span>
                    <Shield className="h-4 w-4" />
                    {t(`archive.collection.groups.${row.group.id}`)}
                  </span>
                  <small>{formatRatio(row.litCount, row.group.species.length)}</small>
                </div>
              ) : (
                <div
                  className="collection-grid collection-grid--virtual-row"
                  style={virtualGridStyle(columns)}
                >
                  {row.species.map((species) => (
                    <CollectionSpeciesCard
                      active={activeSpeciesId === species.id}
                      key={species.id}
                      onSelectSpecies={onSelectSpecies}
                      species={species}
                      t={t}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SpeciesPhotosModal({
  onClose,
  onOpenReview,
  photos,
  species,
  t,
}: {
  onClose: () => void
  onOpenReview: (photoId: string) => void
  photos: PhotoRecord[]
  species: SpeciesRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(photos[0]?.id ?? null)

  useEffect(() => {
    setSelectedPhotoId(photos[0]?.id ?? null)
  }, [photos])

  const selectedPhoto = photos.find((photo) => photo.id === selectedPhotoId) ?? photos[0] ?? null

  return (
    <div className="overlay-backdrop">
      <div className="species-photo-panel">
        <div className="modal-heading">
          <div>
            <SectionLabel label={t('archive.photos.label')} />
            <h2>{species.name}</h2>
            <small>
              {species.latinName} · {t('archive.photos.count', { count: photos.length })}
            </small>
          </div>
          <div className="action-row">
            {selectedPhoto ? (
              <button
                className="button-ghost button-compact"
                onClick={() => onOpenReview(selectedPhoto.id)}
                type="button"
              >
                {t('archive.photos.openReview')}
              </button>
            ) : null}
            <IconButton label={t('common.close')} onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>

        {selectedPhoto ? (
          <div className="species-photo-browser">
            <section className="species-photo-browser__preview">
              <div
                className="species-photo-browser__image"
                style={{
                  backgroundImage:
                    selectedPhoto.placeholderGradient ?? selectedPhoto.previewGradient,
                }}
              >
                <ThumbnailImage
                  alt={selectedPhoto.fileName}
                  className="species-photo-browser__preview-img"
                  src={selectedPhoto.thumbPreviewUrl ?? selectedPhoto.thumbGridUrl}
                />
              </div>
              <div className="species-photo-browser__meta">
                <div>
                  <strong>{selectedPhoto.fileName}</strong>
                  <small>{selectedPhoto.shotAt.replace('T', ' ').slice(0, 16)}</small>
                </div>
                <b>{formatScore(selectedPhoto.finalScore)}</b>
              </div>
            </section>
            <section className="species-photo-browser__rail selection-scroll">
              {photos.map((photo) => (
                <button
                  className={cn(
                    'species-photo-thumb',
                    photo.id === selectedPhoto.id && 'species-photo-thumb--active',
                  )}
                  key={photo.id}
                  onClick={() => setSelectedPhotoId(photo.id)}
                  style={{ backgroundImage: photo.placeholderGradient ?? photo.previewGradient }}
                  type="button"
                >
                  <ThumbnailImage
                    alt={photo.fileName}
                    className="species-photo-thumb__image"
                    src={photo.thumbGridUrl}
                  />
                  <span>
                    <strong>{formatScore(photo.finalScore)}</strong>
                    <small>{photo.fileName}</small>
                  </span>
                </button>
              ))}
            </section>
          </div>
        ) : (
          <p className="archive-map-empty">{t('archive.photos.empty')}</p>
        )}
      </div>
    </div>
  )
}

function ArchiveMetricCell({
  active,
  filterId,
  label,
  onClick,
  signal,
  t,
  tone,
  value,
}: {
  active: boolean
  filterId: SpeciesCollectionFilter
  label: string
  onClick: () => void
  signal: string
  t: ReturnType<typeof useTranslation>['t']
  tone: Tone
  value: number | string
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        'metric-cell',
        'archive-filter-cell',
        `archive-filter-cell--${filterId}`,
        active && 'archive-filter-cell--active',
      )}
      onClick={onClick}
      title={signal}
      type="button"
    >
      <span>{label}</span>
      <strong>{value}</strong>
      <i
        aria-label={t('archive.summarySignalAria', { label, signal })}
        className={cn('status-dot', 'archive-filter-cell__signal', `status-dot--${tone}`)}
        role="img"
      />
    </button>
  )
}

export function ArchiveScreen({
  activeSpecies,
  archivePhotos,
  archiveSpecies,
  archiveTab,
  onOpenReview,
  onSelectSpecies,
  onSetArchiveTab,
  t,
}: {
  activeSpecies: SpeciesRecord | null
  archivePhotos: PhotoRecord[]
  archiveSpecies: SpeciesRecord[]
  archiveTab: ArchiveTab
  onOpenReview: (photoId: string) => void
  onSelectSpecies: (speciesId: string | null) => void
  onSetArchiveTab: (tab: ArchiveTab) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const archiveScrollRef = useRef<HTMLElement | null>(null)
  const [collectionFilter, setCollectionFilter] = useState<SpeciesCollectionFilter>('all')
  const [speciesPhotosOpen, setSpeciesPhotosOpen] = useState(false)
  const activeSpeciesWiki = useMemo(
    () => (activeSpecies ? getSpeciesWiki(activeSpecies.latinName) : null),
    [activeSpecies?.latinName],
  )
  const activeSpeciesImageUrl = activeSpeciesWiki?.image_url ?? null
  const activeSpeciesArtworkAspect = useSpeciesArtworkAspect(activeSpeciesImageUrl)
  const collectedSpeciesCount = archiveSpecies.filter((species) => species.collected).length
  const collectionGroupStats = useMemo(() => {
    return buildSpeciesCollectionGroups(archiveSpecies)
  }, [archiveSpecies])
  const archiveMetricFilters = useMemo(
    () => [
      {
        id: 'collected' as const,
        label: t('archive.summary.collected'),
        signal: t('archive.summarySignals.collected'),
        tone: 'success' as Tone,
        value: collectedSpeciesCount,
      },
      {
        id: 'all' as const,
        label: t('archive.summary.species'),
        signal: t('archive.summarySignals.species'),
        tone: 'neutral' as Tone,
        value: archiveSpecies.length,
      },
      ...collectionGroupStats.map((group) => ({
        id: group.id,
        label: t(`archive.collection.groups.${group.id}`),
        signal: t(`archive.summarySignals.${group.id}`),
        tone: speciesCollectionGroupTone(group.id),
        value: formatRatio(group.litCount, group.species.length),
      })),
    ],
    [archiveSpecies.length, collectedSpeciesCount, collectionGroupStats, t],
  )
  const activeSpeciesPhotos = useMemo(() => {
    if (!activeSpecies) return []
    return archivePhotos.filter((photo) => photoMatchesSpecies(photo, activeSpecies))
  }, [activeSpecies, archivePhotos])
  useEffect(() => {
    setSpeciesPhotosOpen(false)
  }, [activeSpecies?.id])
  const filteredArchiveSpecies = useMemo(() => {
    if (collectionFilter === 'collected') {
      return archiveSpecies.filter((species) => species.collected)
    }
    if (collectionFilter !== 'all') {
      return archiveSpecies.filter(
        (species) => speciesCollectionGroupId(species) === collectionFilter,
      )
    }
    return archiveSpecies
  }, [archiveSpecies, collectionFilter])
  const collectionGroups = useMemo(() => {
    return buildSpeciesCollectionGroups(filteredArchiveSpecies)
  }, [filteredArchiveSpecies])
  useEffect(() => {
    archiveScrollRef.current?.scrollTo({ top: 0 })
  }, [archiveTab, collectionFilter])

  return (
    <main
      className={cn(
        'archive-screen selection-scroll',
        archiveTab === 'map' && 'archive-screen--map',
      )}
      ref={archiveScrollRef}
    >
      <section className={cn('archive-main', archiveTab === 'map' && 'archive-main--map')}>
        <div className="archive-heading">
          <div>
            <SectionLabel label={t('archive.label')} />
            <h1>{t('archive.title')}</h1>
          </div>
          <div className="mini-segment">
            {archiveTabs.map((tab) => (
              <button
                className={cn(archiveTab === tab && 'is-active')}
                key={tab}
                onClick={() => onSetArchiveTab(tab)}
                type="button"
              >
                {t(archiveTabLabelKey(tab))}
              </button>
            ))}
          </div>
        </div>

        {archiveTab === 'species' ? (
          <section className="metric-strip metric-strip--archive">
            {archiveMetricFilters.map((item) => (
              <ArchiveMetricCell
                active={collectionFilter === item.id}
                filterId={item.id}
                key={item.id}
                label={item.label}
                onClick={() => setCollectionFilter(item.id)}
                signal={item.signal}
                t={t}
                tone={item.tone}
                value={item.value}
              />
            ))}
          </section>
        ) : null}

        {archiveTab === 'species' ? (
          <div className="collection-board">
            <VirtualizedCollectionBoard
              activeSpeciesId={activeSpecies?.id ?? null}
              groups={collectionGroups}
              onSelectSpecies={onSelectSpecies}
              scrollRef={archiveScrollRef}
              t={t}
            />
            {collectionGroups.length === 0 ? (
              <p className="collection-empty">{t('archive.collection.empty')}</p>
            ) : null}
          </div>
        ) : (
          <div className="archive-map-layout archive-map-layout--echarts">
            <section className="china-map-card">
              <div className="china-map-card__heading">
                <div>
                  <SectionLabel label={t('archive.map.label')} />
                  <h2>{t('archive.map.title')}</h2>
                </div>
              </div>
              <Suspense
                fallback={
                  <div className="archive-map-empty">{t('archive.geo.loadingProvince')}</div>
                }
              >
                <ArchiveGeoMap onOpenPhoto={onOpenReview} />
              </Suspense>
            </section>
          </div>
        )}
      </section>

      {archiveTab === 'species' ? (
        <aside
          className={cn(
            'archive-detail',
            activeSpecies && 'archive-detail--species',
            activeSpecies && `archive-detail--art-${activeSpeciesArtworkAspect}`,
            activeSpecies && !activeSpeciesImageUrl && 'archive-detail--empty',
          )}
          style={
            activeSpecies
              ? speciesArtworkStyle(activeSpeciesImageUrl, activeSpecies.coverGradient)
              : undefined
          }
        >
          {activeSpecies ? (
            (() => {
              const wiki = activeSpeciesWiki
              const extract = wiki?.zh_extract ?? t('archive.detail.noChineseExtract')
              const sourceUrl = wiki?.zh_url ?? null
              const pinyinText = formatSpeciesPinyin(activeSpecies.name)
              return (
                <div className="archive-detail__content">
                  <div className="archive-detail__heading">
                    <SectionLabel label={t('archive.detail.label')} />
                    <h2>{activeSpecies.name}</h2>
                    {pinyinText ? (
                      <span className="archive-detail__pinyin" data-testid="archive-species-pinyin">
                        {pinyinText}
                      </span>
                    ) : null}
                    <small>{activeSpecies.latinName}</small>
                    <StatusPill
                      label={
                        activeSpecies.collected
                          ? t('archive.collection.collected')
                          : t('archive.collection.locked')
                      }
                      tone={activeSpecies.collected ? 'success' : 'muted'}
                    />
                  </div>
                  <div className="archive-detail__body">
                    <p className="archive-detail__extract">{extract}</p>
                    {sourceUrl ? (
                      <a
                        className="archive-detail__source"
                        href={sourceUrl}
                        onClick={(event) => openExternalLink(event, sourceUrl)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('archive.detail.source')}
                      </a>
                    ) : null}
                    <div className="stat-stack">
                      <StatRow
                        label={t('archive.species.photoCount')}
                        onValueClick={
                          activeSpeciesPhotos.length > 0
                            ? () => setSpeciesPhotosOpen(true)
                            : undefined
                        }
                        valueAriaLabel={t('archive.species.openPhotos', {
                          count: activeSpeciesPhotos.length,
                          species: activeSpecies.name,
                        })}
                        value={activeSpecies.photoCount}
                      />
                      <StatRow
                        label={t('archive.species.firstSeen')}
                        value={
                          activeSpecies.firstSeenAt ? activeSpecies.firstSeenAt.slice(0, 10) : '--'
                        }
                      />
                      <StatRow
                        label={t('archive.species.lastSeen')}
                        value={
                          activeSpecies.lastSeenAt ? activeSpecies.lastSeenAt.slice(0, 10) : '--'
                        }
                      />
                      <StatRow
                        label={t('archive.species.bestScore')}
                        value={formatScore(activeSpecies.bestScore)}
                      />
                      <StatRow
                        label={t('archive.species.rarity')}
                        value={activeSpecies.protectLevel ?? activeSpecies.iucn ?? '--'}
                      />
                    </div>
                  </div>
                </div>
              )
            })()
          ) : (
            <div className="archive-detail__empty">
              <SectionLabel label={t('archive.detail.label')} />
              <p>{t('archive.detail.empty')}</p>
            </div>
          )}
        </aside>
      ) : null}
      {speciesPhotosOpen && activeSpecies ? (
        <SpeciesPhotosModal
          onClose={() => setSpeciesPhotosOpen(false)}
          onOpenReview={onOpenReview}
          photos={activeSpeciesPhotos}
          species={activeSpecies}
          t={t}
        />
      ) : null}
    </main>
  )
}
