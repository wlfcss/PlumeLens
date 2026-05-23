/**
 * 物种详情弹窗子系统 — 点照片/Inspector 上的物种名出维基百科风格的卡片。
 *
 * 三个对外组件:
 *   - SpeciesNameAction:可点击的物种名包装,触发详情弹窗
 *   - SpeciesInfoPopover:弹窗主体(含图、中文简介、保护等级、IUCN、来源链接)
 *   - 配套类型 SpeciesDetailIdentity
 *
 * 弹窗用 createPortal 挂到 document.body,避免被 Inspector 的 overflow:hidden 裁切。
 *
 * 历史:之前住在 App.tsx,因 review-modal.tsx 反向 import 而无法迁出。本次随
 * helpers / 公用组件下放后,这是最后一块 review-modal → @/App 的反向依赖。
 */

import { BookOpenText, ExternalLink, Feather, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { useTranslation } from 'react-i18next'

import { IconButton } from '@/components/common/icon-button'
import { SectionLabel } from '@/components/common/section-label'
import { openExternalLink } from '@/lib/external-link'
import { speciesArtworkAssetUrl } from '@/lib/species-artwork'
import { formatSpeciesPinyin } from '@/lib/species-pinyin'
import { getSpeciesWiki, resolveSpeciesCanonicalSci } from '@/lib/species-wiki'
import { cn } from '@/lib/utils'

export type SpeciesDetailIdentity = {
  englishName?: string | null
  latinName?: string | null
  name?: string | null
}

type SpeciesDetailResolved = {
  canonicalSci: string
  englishName: string | null
  latinName: string
  name: string
  pinyin: string | null
  wiki: ReturnType<typeof getSpeciesWiki> | null
}

function resolveSpeciesDetail(identity: SpeciesDetailIdentity): SpeciesDetailResolved | null {
  const canonicalSci =
    resolveSpeciesCanonicalSci(identity.latinName) ??
    resolveSpeciesCanonicalSci(identity.name) ??
    resolveSpeciesCanonicalSci(identity.englishName)
  const rawLatinName = identity.latinName?.trim() ?? ''
  const latinName = canonicalSci ?? rawLatinName
  if (!latinName) return null

  const wiki = canonicalSci ? (getSpeciesWiki(canonicalSci) ?? null) : null
  const name = wiki?.canonical_zh ?? identity.name?.trim() ?? wiki?.zh_title ?? latinName
  const englishName = wiki?.canonical_en ?? identity.englishName?.trim() ?? null
  return {
    canonicalSci: canonicalSci ?? latinName,
    englishName,
    latinName,
    name,
    pinyin: formatSpeciesPinyin(name),
    wiki,
  }
}

function speciesTooltip(
  identity: SpeciesDetailIdentity,
  t: ReturnType<typeof useTranslation>['t'],
) {
  const detail = resolveSpeciesDetail(identity)
  if (!detail) return undefined
  return detail.pinyin
    ? t('speciesDetail.tooltipWithPinyin', { pinyin: detail.pinyin })
    : t('speciesDetail.tooltip')
}

export function SpeciesInfoPopover({
  identity,
  onClose,
  t,
}: {
  identity: SpeciesDetailIdentity
  onClose: () => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const detail = resolveSpeciesDetail(identity)
  if (!detail) return null

  const wiki = detail.wiki
  const extract = wiki?.zh_extract ?? wiki?.en_extract ?? t('speciesDetail.noExtract')
  const sourceUrl = wiki?.zh_url ?? wiki?.en_url ?? null
  const sourceLabel = wiki?.zh_url ? t('speciesDetail.sourceZh') : t('speciesDetail.sourceEn')
  const imageUrl = speciesArtworkAssetUrl(detail.canonicalSci)
  const familyName = wiki?.family_zh ?? wiki?.family_sci ?? null
  const extractParagraphs = extract
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)

  return (
    <div
      className="overlay-backdrop overlay-backdrop--species-detail"
      data-testid="species-detail-popover"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        aria-label={t('speciesDetail.dialogLabel', { species: detail.name })}
        aria-modal="true"
        className="species-detail-popover"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div
          className={cn(
            'species-detail-popover__art',
            !imageUrl && 'species-detail-popover__art--empty',
          )}
        >
          {imageUrl ? <img alt={detail.name} src={imageUrl} /> : <Feather className="h-8 w-8" />}
          <span>{t('speciesDetail.wikimediaImage')}</span>
        </div>
        <div className="species-detail-popover__body selection-scroll">
          <div className="modal-heading species-detail-popover__heading">
            <div>
              <SectionLabel label={t('speciesDetail.label')} />
              <h2>{detail.name}</h2>
              {detail.pinyin ? (
                <small className="species-pinyin" data-testid="species-pinyin">
                  {detail.pinyin}
                </small>
              ) : null}
              <small className="species-detail-popover__latin">{detail.latinName}</small>
            </div>
            <IconButton label={t('common.close')} onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>

          <div className="species-detail-popover__facts">
            {detail.englishName ? (
              <span>
                {t('speciesDetail.englishName')} <b>{detail.englishName}</b>
              </span>
            ) : null}
            {familyName ? (
              <span>
                {t('speciesDetail.family')} <b>{familyName}</b>
              </span>
            ) : null}
            {wiki?.protect_level ? (
              <span>
                {t('speciesDetail.protectLevel')} <b>{wiki.protect_level}</b>
              </span>
            ) : null}
            {wiki?.iucn ? (
              <span>
                {t('speciesDetail.iucn')} <b>{wiki.iucn}</b>
              </span>
            ) : null}
          </div>

          <section className="species-detail-popover__narrative">
            <div className="species-detail-popover__section-title">
              <BookOpenText className="h-3.5 w-3.5" />
              <span>{t('speciesDetail.descriptionTitle')}</span>
            </div>
            <div className="species-detail-popover__extract">
              {(extractParagraphs.length > 0 ? extractParagraphs : [extract]).map(
                (paragraph, index) => (
                  <p key={`${detail.latinName}-extract-${index}`}>{paragraph}</p>
                ),
              )}
            </div>
          </section>
          {sourceUrl ? (
            <a
              className="species-detail-popover__source"
              href={sourceUrl}
              onClick={(event) => openExternalLink(event, sourceUrl)}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {sourceLabel}
            </a>
          ) : null}
        </div>
      </section>
    </div>
  )
}

export function SpeciesNameAction({
  children,
  className,
  identity,
  t,
}: {
  children: ReactNode
  className?: string
  identity: SpeciesDetailIdentity
  t: ReturnType<typeof useTranslation>['t']
}) {
  const [open, setOpen] = useState(false)
  const detail = resolveSpeciesDetail(identity)
  const title = speciesTooltip(identity, t)
  if (!detail) {
    return (
      <span className={className} title={title}>
        {children}
      </span>
    )
  }

  return (
    <>
      <button
        className={cn('species-name-action', className)}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen(true)
        }}
        title={title}
        type="button"
      >
        {children}
      </button>
      {open
        ? createPortal(
            <SpeciesInfoPopover identity={identity} onClose={() => setOpen(false)} t={t} />,
            document.body,
          )
        : null}
    </>
  )
}
