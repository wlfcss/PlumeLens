/**
 * 羽迹三级地图穿透:中国 → 省 → 市 拍摄点。
 *
 * Level 切换:
 *   country: 中国地图,各省按鸟种数 visualMap 着色,点击省份钻取
 *   province: 该省地图,各市按鸟种数着色,点击市钻取
 *   city: 该市地图 + GPS scatter markers,点击 marker 弹照片卡片
 *
 * 数据:
 *   后端 /archive/geo/{summary,provinces,cities,spots} 已 SQL 聚合
 *   省级 GeoJSON 全国一份(china.json)启动加载;每个省 GeoJSON 用
 *   import.meta.glob 按需 lazy load(钻取时才加载该省 ~50-300 KB)
 *
 * 动画:
 *   钻取/返回用 echarts setOption 内置 animationDuration + 自定义 zoom
 *   transition 实现"放大/缩小"视觉效果
 */
import * as echarts from 'echarts/core'
import { MapChart, ScatterChart, EffectScatterChart } from 'echarts/charts'
import {
  GeoComponent,
  TooltipComponent,
  VisualMapComponent,
  GraphicComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { ChevronRight, Loader2, MapPin, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { useGeoCities, useGeoProvinces, useGeoSpots, useGeoSummary } from '@/hooks/use-archive-geo'
import type { GeoSpot, GeoSpotPhoto } from '@/lib/api-client'
import { ThumbnailImage } from '@/components/thumbnail-image'
import { cn } from '@/lib/utils'

// 注册 echarts 子模块(tree shaking 后只打包用到的部分)
echarts.use([
  MapChart,
  ScatterChart,
  EffectScatterChart,
  GeoComponent,
  TooltipComponent,
  VisualMapComponent,
  GraphicComponent,
  CanvasRenderer,
])

// 全国 GeoJSON 启动一次性加载(~570 KB,但内含所有省界 + 中心点,值得)
import chinaGeoJSON from '@/data/geojson/china.json'

// 省级 GeoJSON 按需 lazy load(用 vite import.meta.glob)
// 文件名约定 {adcode}.json (110000.json / 320000.json ...)
const provinceModules = import.meta.glob<{ default: GeoJSONObject }>('@/data/geojson/[0-9]*.json')

type GeoJSONObject = {
  type: string
  features: Array<{
    type: string
    properties: { name: string; adcode?: number | string; center?: [number, number] }
    geometry: unknown
  }>
}

type Level = 'country' | 'province' | 'city'
type TooltipLine = { label: string; value: string | number }
type GeoRankItem = {
  id: string
  name: string
  photoCount: number
  speciesCount: number
  active: boolean
  onClick: () => void
}

const ALL_SPECIES_FILTER = '__all__'

const MAP_PALETTE = {
  area: '#111111',
  areaLow: '#151515',
  areaMid: '#494949',
  areaHigh: '#f2f2f2',
  border: 'rgba(255,255,255,0.26)',
  borderStrong: 'rgba(255,255,255,0.58)',
  text: '#f4f4f4',
  muted: 'rgba(244,244,244,0.58)',
  accent: '#ff3b30',
  accentSoft: 'rgba(255,59,48,0.26)',
} as const

// 从 china.json 抽 province name → adcode 映射(一级钻取时根据 name 找 adcode 加载省 GeoJSON)
const PROVINCE_TO_ADCODE: Map<string, string> = new Map(
  (chinaGeoJSON as GeoJSONObject).features.map((f) => [
    f.properties.name,
    String(f.properties.adcode ?? ''),
  ]),
)

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function geoTooltip(title: string, lines: TooltipLine[]): string {
  return [
    `<div class="archive-geo-tooltip"><strong>${escapeHtml(title)}</strong>`,
    ...lines.map(
      (line) =>
        `<span><em>${escapeHtml(line.label)}</em><b>${escapeHtml(String(line.value))}</b></span>`,
    ),
    '</div>',
  ].join('')
}

function geoTooltipStyle() {
  return {
    backgroundColor: 'rgba(5,5,5,0.96)',
    borderColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    padding: 0,
    textStyle: { color: MAP_PALETTE.text, fontSize: 12 },
    extraCssText:
      'box-shadow:0 18px 48px rgba(0,0,0,.46);backdrop-filter:blur(16px);border-radius:8px;',
  }
}

function visualMapOption(max: number, t: ReturnType<typeof useTranslation>['t']) {
  return {
    show: false,
    min: 0,
    max,
    inRange: { color: [MAP_PALETTE.areaLow, MAP_PALETTE.areaMid, MAP_PALETTE.areaHigh] },
    text: [t('archive.geo.legendMore'), t('archive.geo.legendNone')],
    orient: 'vertical',
    right: 22,
    bottom: 22,
    textStyle: { color: MAP_PALETTE.muted, fontSize: 10 },
    calculable: false,
    itemHeight: 92,
    itemWidth: 6,
    borderColor: 'rgba(255,255,255,0.2)',
  }
}

async function loadProvinceGeoJSON(adcode: string): Promise<GeoJSONObject | null> {
  const key = Object.keys(provinceModules).find((k) => k.endsWith(`/${adcode}.json`))
  if (!key) return null
  try {
    const mod = await provinceModules[key]()
    return mod.default ?? (mod as unknown as GeoJSONObject) ?? null
  } catch {
    return null
  }
}

interface ArchiveGeoMapProps {
  onOpenPhoto?: (photoId: string) => void
}

export function ArchiveGeoMap({ onOpenPhoto }: ArchiveGeoMapProps): ReactElement {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const [level, setLevel] = useState<Level>('country')
  const [activeProvince, setActiveProvince] = useState<string | null>(null)
  const [activeCity, setActiveCity] = useState<string | null>(null)
  const [provinceGeoJSON, setProvinceGeoJSON] = useState<GeoJSONObject | null>(null)
  const [provinceLoading, setProvinceLoading] = useState(false)
  const [selectedSpot, setSelectedSpot] = useState<GeoSpot | null>(null)

  const summary = useGeoSummary()
  const provincesQ = useGeoProvinces()
  const citiesQ = useGeoCities(level !== 'country' ? activeProvince : null)
  const spotsQ = useGeoSpots(
    level === 'city' ? activeProvince : null,
    level === 'city' ? activeCity : null,
  )

  // 防 race:用户快速点击省 A → 省 B,A 的 lazy load promise 后到时不能覆盖 B 的状态。
  // 用 generation counter:每次发起 load 自增,resolve 时检查是否仍是最新一次发起;
  // 不是就 silently 丢弃 — 不动 state 也不关 loading overlay(让 B 那次自己关)。
  const loadGenRef = useRef(0)

  const openProvince = useCallback((province: string) => {
    const adcode = PROVINCE_TO_ADCODE.get(province)
    if (!adcode) return
    setProvinceLoading(true)
    const myGen = ++loadGenRef.current
    void loadProvinceGeoJSON(adcode)
      .then((json) => {
        if (myGen !== loadGenRef.current) return
        setProvinceLoading(false)
        if (!json) return
        setProvinceGeoJSON(json)
        setActiveProvince(province)
        setActiveCity(null)
        setSelectedSpot(null)
        setLevel('province')
      })
      .catch(() => {
        if (myGen === loadGenRef.current) setProvinceLoading(false)
      })
  }, [])

  const openCity = useCallback((city: string) => {
    setActiveCity(city)
    setSelectedSpot(null)
    setLevel('city')
  }, [])

  const openSpot = useCallback((spot: GeoSpot) => {
    setSelectedSpot(spot)
  }, [])

  // 初始化 ECharts + 注册中国地图
  useEffect(() => {
    if (!containerRef.current) return
    const chart = echarts.init(containerRef.current, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    // echarts.registerMap 的 GeoJSONSourceInput 类型在 6.0 较严格,用
    // unknown → Parameters[1] 兜过去(GeoJSON 数据是第三方,跑通即可)
    echarts.registerMap('china', { geoJSON: chinaGeoJSON } as unknown as Parameters<
      typeof echarts.registerMap
    >[1])
    const handleResize = () => chart.resize()
    window.addEventListener('resize', handleResize)
    // ResizeObserver 处理父容器尺寸变化(更精确)
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(containerRef.current)
    return () => {
      window.removeEventListener('resize', handleResize)
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  // ---------------------- 一级:中国全图 ----------------------
  useEffect(() => {
    if (level !== 'country' || !chartRef.current) return
    const chart = chartRef.current
    const data = provincesQ.data ?? []
    // 用拉丁名(latin)作 series.name,避免和"china"地图名混淆
    const max = Math.max(1, ...data.map((p) => p.species_count))
    const seriesData = data.map((p) => ({
      name: p.province,
      value: p.species_count,
      photoCount: p.photo_count,
    }))

    chart.setOption(
      {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'item',
          ...geoTooltipStyle(),
          formatter: (params: { name: string; data?: { photoCount?: number } }) => {
            const row = data.find((x) => x.province === params.name)
            if (!row) {
              return geoTooltip(params.name, [{ label: t('archive.geo.noData'), value: '--' }])
            }
            return geoTooltip(params.name, [
              { label: t('archive.geo.speciesLabel'), value: row.species_count },
              { label: t('archive.geo.photosLabel'), value: row.photo_count },
            ])
          },
        },
        visualMap: data.length > 0 ? visualMapOption(max, t) : undefined,
        geo: {
          map: 'china',
          roam: true,
          zoom: 1.15,
          layoutCenter: ['43%', '54%'],
          layoutSize: '82%',
          scaleLimit: { min: 0.8, max: 5 },
          itemStyle: {
            areaColor: MAP_PALETTE.area,
            borderColor: MAP_PALETTE.border,
            borderWidth: 0.7,
          },
          emphasis: {
            itemStyle: { areaColor: '#f5f5f5', borderColor: MAP_PALETTE.accent },
            label: { show: true, color: '#050505', fontSize: 11, fontWeight: 700 },
          },
          select: { disabled: true },
          label: { show: false },
        },
        series: [
          {
            type: 'map',
            geoIndex: 0,
            name: 'provinces',
            data: seriesData,
          },
        ],
        animation: true,
        animationDuration: 600,
        animationEasing: 'cubicOut',
      } as Parameters<echarts.ECharts['setOption']>[0],
      { notMerge: true },
    )
  }, [level, provincesQ.data, t])

  // ---------------------- 二级:省地图 ----------------------
  useEffect(() => {
    if (level !== 'province' || !provinceGeoJSON || !chartRef.current) return
    const chart = chartRef.current
    const mapName = `province-${activeProvince}`
    echarts.registerMap(mapName, { geoJSON: provinceGeoJSON } as unknown as Parameters<
      typeof echarts.registerMap
    >[1])
    const data = citiesQ.data ?? []
    const max = Math.max(1, ...data.map((c) => c.species_count))

    chart.setOption(
      {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'item',
          ...geoTooltipStyle(),
          formatter: (params: { name: string }) => {
            const row = data.find((x) => x.city === params.name)
            if (!row) {
              return geoTooltip(params.name, [{ label: t('archive.geo.noData'), value: '--' }])
            }
            return geoTooltip(params.name, [
              { label: t('archive.geo.speciesLabel'), value: row.species_count },
              { label: t('archive.geo.photosLabel'), value: row.photo_count },
            ])
          },
        },
        visualMap: data.length > 0 ? visualMapOption(max, t) : undefined,
        geo: {
          map: mapName,
          roam: true,
          zoom: 1.05,
          layoutCenter: ['43%', '54%'],
          layoutSize: '84%',
          scaleLimit: { min: 0.8, max: 5 },
          itemStyle: {
            areaColor: MAP_PALETTE.area,
            borderColor: MAP_PALETTE.border,
            borderWidth: 0.7,
          },
          emphasis: {
            itemStyle: { areaColor: '#f5f5f5', borderColor: MAP_PALETTE.accent },
            label: { show: true, color: '#050505', fontSize: 11, fontWeight: 700 },
          },
          select: { disabled: true },
          label: { show: false },
        },
        series: [
          {
            type: 'map',
            geoIndex: 0,
            name: 'cities',
            data: data.map((c) => ({
              name: c.city,
              value: c.species_count,
            })),
          },
        ],
        animation: true,
        animationDuration: 700,
        animationEasing: 'cubicOut',
      } as Parameters<echarts.ECharts['setOption']>[0],
      { notMerge: true },
    )
  }, [level, provinceGeoJSON, activeProvince, citiesQ.data, t])

  // ---------------------- 三级:市级 + GPS scatter ----------------------
  useEffect(() => {
    if (level !== 'city' || !provinceGeoJSON || !chartRef.current) return
    const chart = chartRef.current
    const mapName = `province-${activeProvince}`
    const spots = spotsQ.data ?? []
    // city marker 数据(GPS scatter)
    const scatterData = spots.map((s) => ({
      name: s.place ?? '',
      value: [s.lon, s.lat, s.photo_count],
      spot: s,
    }))
    const maxPhotos = Math.max(1, ...spots.map((s) => s.photo_count))

    chart.setOption(
      {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'item',
          ...geoTooltipStyle(),
          formatter: (params: { data?: { spot?: GeoSpot; name?: string } }) => {
            const spot = params.data?.spot
            if (!spot) return escapeHtml(params.data?.name ?? '')
            const place = spot.place ?? t('archive.geo.unknownPlace')
            return geoTooltip(place, [
              { label: t('archive.geo.speciesLabel'), value: spot.species_count },
              { label: t('archive.geo.photosLabel'), value: spot.photo_count },
            ])
          },
        },
        geo: {
          map: mapName,
          roam: true,
          zoom: 1,
          layoutCenter: ['43%', '54%'],
          layoutSize: '84%',
          scaleLimit: { min: 0.5, max: 12 },
          itemStyle: {
            areaColor: MAP_PALETTE.area,
            borderColor: MAP_PALETTE.border,
            borderWidth: 0.6,
          },
          emphasis: {
            itemStyle: { areaColor: '#1c1c1c', borderColor: MAP_PALETTE.borderStrong },
            label: { show: false },
          },
          select: { disabled: true },
          label: { show: true, color: 'rgba(255,255,255,0.34)', fontSize: 9 },
        },
        series: [
          {
            type: 'effectScatter',
            coordinateSystem: 'geo',
            symbolSize: (val: number[]) => Math.max(8, Math.min(28, 6 + (val[2] / maxPhotos) * 22)),
            itemStyle: {
              color: MAP_PALETTE.accent,
              borderColor: '#fff',
              borderWidth: 1,
              shadowColor: MAP_PALETTE.accentSoft,
              shadowBlur: 14,
            },
            rippleEffect: { brushType: 'stroke', scale: 2.1, period: 4 },
            data: scatterData,
            zlevel: 2,
          },
        ],
        animation: true,
        animationDuration: 700,
        animationEasing: 'cubicOut',
      } as Parameters<echarts.ECharts['setOption']>[0],
      { notMerge: true },
    )
  }, [level, provinceGeoJSON, activeProvince, spotsQ.data, t])

  // ---------------------- 点击事件 ----------------------
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const handler = (params: unknown) => {
      const p = params as {
        seriesType?: string
        name?: string
        data?: { spot?: GeoSpot } | null
      }
      // 点省份(一级地图):钻取到二级
      if (level === 'country' && p.name) {
        openProvince(p.name)
        return
      }
      // 点市(二级地图):钻取到三级
      if (level === 'province' && p.name) {
        openCity(p.name)
        return
      }
      // 点 spot marker(三级):弹卡片
      if (level === 'city' && p.seriesType === 'effectScatter') {
        const spot = p.data?.spot
        if (spot) openSpot(spot)
      }
    }
    chart.on('click', handler)
    return () => {
      chart.off('click', handler)
    }
  }, [level, openCity, openProvince, openSpot])

  // ---------------------- 面包屑导航 ----------------------
  const breadcrumbs = useMemo(() => {
    const parts: Array<{ label: string; level: Level }> = [
      { label: t('archive.geo.country'), level: 'country' },
    ]
    if (level !== 'country' && activeProvince) {
      parts.push({ label: activeProvince, level: 'province' })
    }
    if (level === 'city' && activeCity) {
      parts.push({ label: activeCity, level: 'city' })
    }
    return parts
  }, [level, activeProvince, activeCity, t])

  const handleCrumbClick = useCallback((target: Level) => {
    if (target === 'country') {
      setLevel('country')
      setActiveProvince(null)
      setActiveCity(null)
      setSelectedSpot(null)
    } else if (target === 'province') {
      setLevel('province')
      setActiveCity(null)
      setSelectedSpot(null)
    }
  }, [])

  const dismissSpot = useCallback(() => setSelectedSpot(null), [])

  // 关键 indicator(顶部"X 个省份有照片"展示用)
  const provincesCount = (provincesQ.data ?? []).length
  const hasSummary = Boolean(summary.data)
  const mappedCount = summary.data?.resolved ?? 0
  const pendingCount = summary.data?.pending ?? 0
  const noGpsCount = summary.data?.photos_without_gps ?? 0
  const currentTitle = activeCity ?? activeProvince ?? t('archive.geo.country')
  const childCount =
    level === 'country'
      ? provincesCount
      : level === 'province'
        ? (citiesQ.data ?? []).length
        : (spotsQ.data ?? []).length
  const childCountLabel =
    level === 'country'
      ? t('archive.geo.statProvinces', { count: childCount })
      : level === 'province'
        ? t('archive.geo.statCities', { count: childCount })
        : t('archive.geo.statSpots', { count: childCount })
  const levelLabel = t(`archive.geo.level.${level}`)
  const rankItems = useMemo<GeoRankItem[]>(() => {
    if (level === 'country') {
      return (provincesQ.data ?? [])
        .toSorted((a, b) => b.photo_count - a.photo_count || b.species_count - a.species_count)
        .slice(0, 8)
        .map((province) => ({
          id: province.province,
          name: province.province,
          photoCount: province.photo_count,
          speciesCount: province.species_count,
          active: activeProvince === province.province,
          onClick: () => openProvince(province.province),
        }))
    }
    if (level === 'province') {
      return (citiesQ.data ?? [])
        .toSorted((a, b) => b.photo_count - a.photo_count || b.species_count - a.species_count)
        .slice(0, 8)
        .map((city) => ({
          id: city.city,
          name: city.city,
          photoCount: city.photo_count,
          speciesCount: city.species_count,
          active: activeCity === city.city,
          onClick: () => openCity(city.city),
        }))
    }
    return (spotsQ.data ?? [])
      .toSorted((a, b) => b.photo_count - a.photo_count || b.species_count - a.species_count)
      .slice(0, 8)
      .map((spot) => {
        const id = `${spot.lat.toFixed(4)}-${spot.lon.toFixed(4)}`
        return {
          id,
          name: spot.place ?? t('archive.geo.unknownPlace'),
          photoCount: spot.photo_count,
          speciesCount: spot.species_count,
          active:
            selectedSpot !== null &&
            selectedSpot.lat.toFixed(4) === spot.lat.toFixed(4) &&
            selectedSpot.lon.toFixed(4) === spot.lon.toFixed(4),
          onClick: () => openSpot(spot),
        }
      })
  }, [
    activeCity,
    activeProvince,
    citiesQ.data,
    level,
    openCity,
    openProvince,
    openSpot,
    provincesQ.data,
    selectedSpot,
    spotsQ.data,
    t,
  ])

  return (
    <div className="archive-geo">
      <div className="archive-geo__head">
        <nav className="archive-geo__crumbs" aria-label="breadcrumb">
          {breadcrumbs.map((c, i) => (
            <span key={`${c.level}-${i}`} className="archive-geo__crumb-row">
              {i > 0 ? <ChevronRight className="h-3 w-3 opacity-40" /> : null}
              <button
                className={cn(
                  'archive-geo__crumb',
                  i === breadcrumbs.length - 1 && 'archive-geo__crumb--active',
                )}
                onClick={() => handleCrumbClick(c.level)}
                disabled={i === breadcrumbs.length - 1}
                type="button"
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <div className="archive-geo__indicators">
          {hasSummary ? (
            pendingCount > 0 ? (
              <span className="archive-geo__sync archive-geo__sync--running">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('archive.geo.backfillProgress', {
                  resolved: mappedCount,
                  total: mappedCount + pendingCount,
                })}
              </span>
            ) : (
              <span className="archive-geo__sync">
                <span aria-hidden="true" />
                {t('archive.geo.synced')}
              </span>
            )
          ) : null}
        </div>
      </div>

      <div className="archive-geo__metrics" aria-label={t('archive.geo.statsLabel')}>
        <span>
          <b>{mappedCount}</b>
          <small>{t('archive.geo.statsMapped')}</small>
        </span>
        <span>
          <b>{pendingCount}</b>
          <small>{t('archive.geo.statsPending')}</small>
        </span>
        <span>
          <b>{noGpsCount}</b>
          <small>{t('archive.geo.statsNoGps')}</small>
        </span>
      </div>

      <div className="archive-geo__canvas">
        <div className="archive-geo__canvas-hud">
          <span>{levelLabel}</span>
          <strong>{currentTitle}</strong>
          <small>{childCountLabel}</small>
        </div>
        <div className="archive-geo__legend" aria-label={t('archive.geo.density')}>
          <span>{t('archive.geo.density')}</span>
          <i aria-hidden="true" />
          <small>{t('archive.geo.legendNone')}</small>
          <small>{t('archive.geo.legendMore')}</small>
        </div>
        <div ref={containerRef} className="archive-geo__chart" />
        <aside className="archive-geo__rank" aria-label={t('archive.geo.hotspots')}>
          <div className="archive-geo__rank-head">
            <span>{t('archive.geo.hotspots')}</span>
            <small>{levelLabel}</small>
          </div>
          {rankItems.length > 0 ? (
            <div className="archive-geo__rank-list">
              {rankItems.map((item, index) => (
                <button
                  className={cn('archive-geo__rank-item', item.active && 'is-active')}
                  key={item.id}
                  onClick={item.onClick}
                  type="button"
                >
                  <em>{String(index + 1).padStart(2, '0')}</em>
                  <span>
                    <b>{item.name}</b>
                    <small>{t('archive.geo.rankSpecies', { count: item.speciesCount })}</small>
                  </span>
                  <strong>{t('archive.geo.rankPhotos', { count: item.photoCount })}</strong>
                </button>
              ))}
            </div>
          ) : (
            <p>{t('archive.geo.rankEmpty')}</p>
          )}
        </aside>
        {provinceLoading ? (
          <div className="archive-geo__overlay">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>{t('archive.geo.loadingProvince')}</span>
          </div>
        ) : null}
      </div>

      <p className="archive-geo__note">
        {summary.data && summary.data.photos_without_gps > 0
          ? t('archive.geo.unmapped', { count: summary.data.photos_without_gps })
          : t('archive.geo.allMapped')}
      </p>

      {/* 三级 spot 详情弹卡 */}
      {selectedSpot ? (
        <SpotDetail spot={selectedSpot} onClose={dismissSpot} onOpenPhoto={onOpenPhoto} t={t} />
      ) : null}
    </div>
  )
}

interface SpotDetailProps {
  spot: GeoSpot
  onClose: () => void
  onOpenPhoto?: (photoId: string) => void
  t: ReturnType<typeof useTranslation>['t']
}

function SpotDetail({ spot, onClose, onOpenPhoto, t }: SpotDetailProps): ReactElement {
  const [activeSpeciesKey, setActiveSpeciesKey] = useState(ALL_SPECIES_FILTER)
  const speciesOptions = useMemo(
    () =>
      spot.species.map((species) => ({
        key: geoSpeciesFilterKey(species),
        name: species.name || species.latin_name || t('archive.geo.unknownSpecies'),
        photoCount: species.photo_count,
      })),
    [spot.species, t],
  )
  const activeSpecies = speciesOptions.find((item) => item.key === activeSpeciesKey) ?? null
  const filteredPhotos = useMemo(() => {
    if (activeSpeciesKey === ALL_SPECIES_FILTER) return spot.photos
    return spot.photos.filter((photo) => photoMatchesSpeciesFilter(photo, activeSpeciesKey))
  }, [activeSpeciesKey, spot.photos])

  useEffect(() => {
    setActiveSpeciesKey(ALL_SPECIES_FILTER)
  }, [spot.lat, spot.lon, spot.place])

  const filterTotal = activeSpecies?.photoCount ?? spot.photo_count

  return (
    <div className="archive-geo__spot-overlay" onClick={onClose}>
      <div
        className="archive-geo__spot-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="archive-geo__spot-sticky">
          <header className="archive-geo__spot-head">
            <div>
              <MapPin className="h-4 w-4" />
              <strong>{spot.place ?? t('archive.geo.unknownPlace')}</strong>
              <small>
                {spot.lat.toFixed(5)}°, {spot.lon.toFixed(5)}°
              </small>
            </div>
            <button
              aria-label={t('common.close')}
              className="icon-button"
              onClick={onClose}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="archive-geo__spot-meta">
            <span>{t('archive.geo.tooltipSpecies', { count: spot.species_count })}</span>
            <span>{t('archive.geo.tooltipPhotos', { count: spot.photo_count })}</span>
          </div>
          <section
            className="archive-geo__species-filter"
            aria-label={t('archive.geo.speciesFilter')}
          >
            <div className="archive-geo__species-filter-head">
              <span>{t('archive.geo.speciesFilter')}</span>
              <small>
                {t('archive.geo.filteredPhotos', {
                  shown: filteredPhotos.length,
                  total: filterTotal,
                })}
              </small>
            </div>
            <div className="archive-geo__species-filter-list">
              <button
                aria-pressed={activeSpeciesKey === ALL_SPECIES_FILTER}
                className={cn(
                  'archive-geo__species-filter-item',
                  activeSpeciesKey === ALL_SPECIES_FILTER && 'is-active',
                )}
                onClick={() => setActiveSpeciesKey(ALL_SPECIES_FILTER)}
                type="button"
              >
                <span>{t('archive.geo.allSpecies')}</span>
                <small>{t('archive.geo.rankPhotos', { count: spot.photo_count })}</small>
              </button>
              {speciesOptions.map((item) => (
                <button
                  aria-pressed={activeSpeciesKey === item.key}
                  className={cn(
                    'archive-geo__species-filter-item',
                    activeSpeciesKey === item.key && 'is-active',
                  )}
                  key={item.key}
                  onClick={() => setActiveSpeciesKey(item.key)}
                  type="button"
                >
                  <span>{item.name}</span>
                  <small>{t('archive.geo.rankPhotos', { count: item.photoCount })}</small>
                </button>
              ))}
            </div>
          </section>
        </div>
        <div className="archive-geo__spot-grid" aria-live="polite">
          {filteredPhotos.length > 0 ? (
            filteredPhotos.map((photo) => (
              <button
                key={photo.photo_id}
                className="archive-geo__spot-thumb"
                onClick={() => onOpenPhoto?.(photo.photo_id)}
                type="button"
              >
                <ThumbnailImage
                  alt={photo.file_name}
                  className="archive-geo__spot-thumb-img"
                  loading="lazy"
                  src={photo.thumb_grid ? `plumelens://thumb/${photo.thumb_grid}` : null}
                />
                <span className="archive-geo__spot-thumb-meta">
                  <small>
                    {formatSpeciesList(photo.species, t) ??
                      photo.species_zh ??
                      photo.species_latin ??
                      photo.file_name}
                  </small>
                </span>
              </button>
            ))
          ) : (
            <p className="archive-geo__spot-empty">{t('archive.geo.filterEmpty')}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function geoSpeciesFilterKey(species: { name: string; latin_name?: string | null }): string {
  return species.latin_name ? `latin:${species.latin_name}` : `name:${species.name}`
}

function photoMatchesSpeciesFilter(photo: GeoSpotPhoto, speciesKey: string): boolean {
  if (speciesKey === ALL_SPECIES_FILTER) return true
  if (photo.species.some((species) => geoSpeciesFilterKey(species) === speciesKey)) return true
  if (photo.species_latin && `latin:${photo.species_latin}` === speciesKey) return true
  if (photo.species_zh && `name:${photo.species_zh}` === speciesKey) return true
  return false
}

function formatSpeciesList(
  species: Array<{ name: string; latin_name?: string | null }> | undefined,
  t: ReturnType<typeof useTranslation>['t'],
): string | null {
  if (!species || species.length === 0) return null
  const primary = species[0]?.name || species[0]?.latin_name
  if (!primary) return null
  return species.length === 1
    ? primary
    : t('selection.photo.speciesEtc', { name: primary, count: species.length })
}
