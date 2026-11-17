import { Bird, ChevronDown, X } from 'lucide-react'
import { pinyin } from 'pinyin-pro'
import { useEffect, useId, useMemo, useRef, useState, type ToggleEvent } from 'react'
import { useTranslation } from 'react-i18next'

import type { SelectionSpeciesFacet } from '@/lib/api-client'
import type { SelectionSpeciesFilter } from '@/stores/ui-store'
import './species-filter.css'

export interface SpeciesFilterProps {
  facets: SelectionSpeciesFacet[]
  filter: SelectionSpeciesFilter
  onChange: (filter: SelectionSpeciesFilter) => void
  loading: boolean
  error: boolean
  onRetry: () => void
}

export function SpeciesFilter({
  facets,
  filter,
  onChange,
  loading,
  error,
  onRetry,
}: SpeciesFilterProps) {
  const { t } = useTranslation()
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const order = useRef<string[]>([])
  const known = useRef(new Map<string, SelectionSpeciesFacet>())
  facets.forEach((facet) => known.current.set(facet.key, facet))
  useEffect(() => {
    if (!open) return
    const reposition = (event: Event) => {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      if (rect.bottom < 0 || rect.top > window.innerHeight || trigger.current?.closest('[inert]')) {
        panel.current?.hidePopover()
        return
      }
      setPosition({
        top: Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - 448)),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 352)),
      })
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])
  const options = useMemo(() => {
    const rows = [...facets]
    for (const key of filter.keys) {
      if (rows.some((row) => row.key === key)) continue
      const previous = known.current.get(key)
      rows.push(
        previous
          ? { ...previous, photo_count: 0, review_photo_count: 0 }
          : {
              key,
              name: key.replace(/^sci:/, ''),
              latin_name: null,
              english_name: null,
              search_aliases: [],
              photo_count: 0,
              review_photo_count: 0,
            },
      )
    }
    if (open)
      rows.sort((a, b) => {
        const left = order.current.indexOf(a.key)
        const right = order.current.indexOf(b.key)
        return (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right)
      })
    else
      rows.sort(
        (a, b) =>
          Number(filter.keys.includes(b.key)) - Number(filter.keys.includes(a.key)) ||
          b.photo_count - a.photo_count ||
          a.name.localeCompare(b.name, 'zh-CN'),
      )
    return rows
  }, [facets, filter.keys, open])
  const visible = options.filter((option) => {
    const syllables = pinyin(option.name, { toneType: 'none', type: 'array' })
    return [
      option.name,
      option.latin_name,
      option.english_name,
      ...option.search_aliases,
      syllables.join(''),
      syllables.map((part) => part[0]).join(''),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  })
  function handleToggle(event: ToggleEvent<HTMLDivElement>) {
    const next = event.newState === 'open'
    if (next) {
      order.current = options.map((option) => option.key)
      const rect = trigger.current!.getBoundingClientRect()
      setPosition({
        top: Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - 448)),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 352)),
      })
      setQuery('')
      requestAnimationFrame(() => search.current?.focus({ preventScroll: true }))
    }
    setOpen(next)
  }
  const selectedName =
    filter.keys.length === 1
      ? filter.keys[0] === 'state:unidentified'
        ? t('selection.speciesFilter.unidentified')
        : options.find((option) => option.key === filter.keys[0])?.name
      : null
  return (
    <div className="species-filter" data-selection-filter>
      <button
        className="chip species-filter__trigger"
        ref={trigger}
        type="button"
        popoverTarget={id}
        aria-controls={id}
        aria-expanded={open}
      >
        <Bird className="h-3.5 w-3.5" />
        {t('selection.speciesFilter.trigger', {
          value:
            selectedName ??
            (filter.keys.length
              ? t('selection.speciesFilter.selectedCount', { count: filter.keys.length })
              : t('selection.speciesFilter.all')),
        })}
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        className="species-filter__panel"
        style={position}
        onToggle={handleToggle}
      >
        <div className="species-filter__heading">
          <strong>{t('selection.speciesFilter.title')}</strong>
          <button
            className="button-ghost button-compact"
            type="button"
            onClick={() => onChange({ keys: [], includeReview: true })}
          >
            {t('selection.speciesFilter.clearOnly')}
          </button>
        </div>
        <search>
          <label htmlFor={`${id}-search`}>{t('selection.speciesFilter.searchLabel')}</label>
          <input
            id={`${id}-search`}
            name="species-search"
            ref={search}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t('selection.speciesFilter.searchPlaceholder')}
          />
        </search>
        <label className="species-filter__review">
          <input
            type="checkbox"
            name="include-review"
            checked={filter.includeReview}
            onChange={(event) => onChange({ ...filter, includeReview: event.target.checked })}
          />
          {t('selection.speciesFilter.includeReview')}
        </label>
        <p className="species-filter__hint">{t('selection.speciesFilter.reviewHint')}</p>
        {error ? (
          <div role="alert">
            {t('selection.speciesFilter.error')}{' '}
            <button type="button" className="button-ghost" onClick={onRetry}>
              {t('common.retry')}
            </button>
          </div>
        ) : null}
        <div className="species-filter__options-scroll">
          <fieldset className="species-filter__options" aria-busy={loading}>
            <legend className="sr-only">{t('selection.speciesFilter.optionsLabel')}</legend>
            {visible.map((option) => (
              <label
                key={option.key}
                className={
                  option.photo_count === 0
                    ? 'species-filter__option is-empty'
                    : 'species-filter__option'
                }
              >
                <input
                  type="checkbox"
                  name="species"
                  value={option.key}
                  checked={filter.keys.includes(option.key)}
                  onChange={(event) =>
                    onChange({
                      ...filter,
                      keys: event.target.checked
                        ? [...filter.keys, option.key]
                        : filter.keys.filter((key) => key !== option.key),
                    })
                  }
                />
                <span>
                  <span>
                    {option.key === 'state:unidentified'
                      ? t('selection.speciesFilter.unidentified')
                      : option.name}
                  </span>
                  {option.latin_name ? <small>{option.latin_name}</small> : null}
                  {option.review_photo_count > 0 ? (
                    <small className="species-filter__pending">
                      {t('selection.speciesFilter.reviewCount', {
                        count: option.review_photo_count,
                      })}
                    </small>
                  ) : null}
                </span>
                <span className="species-filter__count">
                  {t('selection.speciesFilter.photoCount', { count: option.photo_count })}
                </span>
              </label>
            ))}
          </fieldset>
        </div>
        {!visible.length && !loading && !error ? (
          <p>{t('selection.speciesFilter.noOptions')}</p>
        ) : null}
        <div className="species-filter__footer">
          <span>
            {t(loading ? 'selection.speciesFilter.updating' : 'selection.speciesFilter.countHint')}
          </span>
          <button
            className="button-primary button-compact"
            type="button"
            onClick={() => {
              panel.current?.hidePopover()
              trigger.current?.focus()
            }}
          >
            {t('selection.speciesFilter.done')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function SpeciesFilterChips({ facets, filter, onChange }: SpeciesFilterProps) {
  const { t } = useTranslation()
  return (
    <>
      {!filter.includeReview && filter.keys.length > 0 ? (
        <button
          type="button"
          className="chip"
          onClick={() => onChange({ ...filter, includeReview: true })}
        >
          {t('selection.speciesFilter.reviewExcluded')}
          <X aria-hidden="true" className="h-3 w-3" />
          <span className="sr-only">{t('selection.speciesFilter.remove')}</span>
        </button>
      ) : null}
      {filter.keys.map((key) => (
        <button
          className="chip"
          type="button"
          key={key}
          onClick={() => onChange({ ...filter, keys: filter.keys.filter((item) => item !== key) })}
        >
          {key === 'state:unidentified'
            ? t('selection.speciesFilter.unidentified')
            : (facets.find((facet) => facet.key === key)?.name ?? key.replace(/^sci:/, ''))}
          <X aria-hidden="true" className="h-3 w-3" />
          <span className="sr-only">{t('selection.speciesFilter.remove')}</span>
        </button>
      ))}
    </>
  )
}
