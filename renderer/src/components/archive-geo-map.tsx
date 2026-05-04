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
import { ChevronRight, Loader2, MapPin } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import {
  useGeoCities,
  useGeoProvinces,
  useGeoSpots,
  useGeoSummary,
} from '@/hooks/use-archive-geo'
import type { GeoSpot } from '@/lib/api-client'
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
const provinceModules = import.meta.glob<{ default: GeoJSONObject }>(
  '@/data/geojson/*.json',
)

type GeoJSONObject = {
  type: string
  features: Array<{
    type: string
    properties: { name: string; adcode?: number | string; center?: [number, number] }
    geometry: unknown
  }>
}

type Level = 'country' | 'province' | 'city'

// 从 china.json 抽 province name → adcode 映射(一级钻取时根据 name 找 adcode 加载省 GeoJSON)
const PROVINCE_TO_ADCODE: Map<string, string> = new Map(
  (chinaGeoJSON as GeoJSONObject).features.map((f) => [
    f.properties.name,
    String(f.properties.adcode ?? ''),
  ]),
)

async function loadProvinceGeoJSON(adcode: string): Promise<GeoJSONObject | null> {
  const key = Object.keys(provinceModules).find((k) => k.endsWith(`/${adcode}.json`))
  if (!key) return null
  try {
    const mod = await provinceModules[key]()
    return (mod.default ?? (mod as unknown as GeoJSONObject)) ?? null
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

  // 初始化 ECharts + 注册中国地图
  useEffect(() => {
    if (!containerRef.current) return
    const chart = echarts.init(containerRef.current, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    // echarts.registerMap 的 GeoJSONSourceInput 类型在 6.0 较严格,用
    // unknown → Parameters[1] 兜过去(GeoJSON 数据是第三方,跑通即可)
    echarts.registerMap(
      'china',
      { geoJSON: chinaGeoJSON } as unknown as Parameters<typeof echarts.registerMap>[1],
    )
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
          backgroundColor: 'rgba(15,15,15,0.92)',
          borderColor: 'rgba(255,255,255,0.12)',
          textStyle: { color: '#eee', fontSize: 12 },
          formatter: (params: { name: string; data?: { photoCount?: number } }) => {
            const row = data.find((x) => x.province === params.name)
            if (!row) {
              return `<b>${params.name}</b><br/>${t('archive.geo.noData')}`
            }
            return `<b>${params.name}</b><br/>${t('archive.geo.tooltipSpecies', { count: row.species_count })}<br/>${t('archive.geo.tooltipPhotos', { count: row.photo_count })}`
          },
        },
        visualMap: data.length > 0
          ? {
              min: 0,
              max,
              inRange: { color: ['#0d1f14', '#1f5b34', '#3aa860', '#84e09d'] },
              text: [t('archive.geo.legendMore'), t('archive.geo.legendNone')],
              orient: 'vertical',
              left: 16,
              bottom: 16,
              textStyle: { color: 'rgba(255,255,255,0.55)', fontSize: 10 },
              calculable: false,
              itemHeight: 80,
              itemWidth: 8,
            }
          : undefined,
        geo: {
          map: 'china',
          roam: true,
          zoom: 1.15,
          scaleLimit: { min: 0.8, max: 5 },
          itemStyle: {
            areaColor: '#0a1410',
            borderColor: 'rgba(255,255,255,0.18)',
            borderWidth: 0.6,
          },
          emphasis: {
            itemStyle: { areaColor: '#3aa860', borderColor: '#84e09d' },
            label: { show: true, color: '#fff', fontSize: 11 },
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
    echarts.registerMap(
      mapName,
      { geoJSON: provinceGeoJSON } as unknown as Parameters<typeof echarts.registerMap>[1],
    )
    const data = citiesQ.data ?? []
    const max = Math.max(1, ...data.map((c) => c.species_count))

    chart.setOption(
      {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'item',
          backgroundColor: 'rgba(15,15,15,0.92)',
          borderColor: 'rgba(255,255,255,0.12)',
          textStyle: { color: '#eee', fontSize: 12 },
          formatter: (params: { name: string }) => {
            const row = data.find((x) => x.city === params.name)
            if (!row) {
              return `<b>${params.name}</b><br/>${t('archive.geo.noData')}`
            }
            return `<b>${params.name}</b><br/>${t('archive.geo.tooltipSpecies', { count: row.species_count })}<br/>${t('archive.geo.tooltipPhotos', { count: row.photo_count })}`
          },
        },
        visualMap: data.length > 0
          ? {
              min: 0,
              max,
              inRange: { color: ['#0d1f14', '#1f5b34', '#3aa860', '#84e09d'] },
              text: [t('archive.geo.legendMore'), t('archive.geo.legendNone')],
              orient: 'vertical',
              left: 16,
              bottom: 16,
              textStyle: { color: 'rgba(255,255,255,0.55)', fontSize: 10 },
              calculable: false,
              itemHeight: 80,
              itemWidth: 8,
            }
          : undefined,
        geo: {
          map: mapName,
          roam: true,
          zoom: 1.05,
          scaleLimit: { min: 0.8, max: 5 },
          itemStyle: {
            areaColor: '#0a1410',
            borderColor: 'rgba(255,255,255,0.22)',
            borderWidth: 0.7,
          },
          emphasis: {
            itemStyle: { areaColor: '#3aa860', borderColor: '#84e09d' },
            label: { show: true, color: '#fff', fontSize: 11 },
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
          backgroundColor: 'rgba(15,15,15,0.92)',
          borderColor: 'rgba(255,255,255,0.12)',
          textStyle: { color: '#eee', fontSize: 12 },
          formatter: (params: { data?: { spot?: GeoSpot; name?: string } }) => {
            const spot = params.data?.spot
            if (!spot) return params.data?.name ?? ''
            const place = spot.place ?? t('archive.geo.unknownPlace')
            return `<b>${place}</b><br/>${t('archive.geo.tooltipSpecies', { count: spot.species_count })}<br/>${t('archive.geo.tooltipPhotos', { count: spot.photo_count })}`
          },
        },
        geo: {
          map: mapName,
          roam: true,
          zoom: 1,
          scaleLimit: { min: 0.5, max: 12 },
          itemStyle: {
            areaColor: '#0a1410',
            borderColor: 'rgba(255,255,255,0.2)',
            borderWidth: 0.6,
          },
          emphasis: {
            itemStyle: { areaColor: '#162a1d', borderColor: 'rgba(255,255,255,0.3)' },
            label: { show: false },
          },
          select: { disabled: true },
          label: { show: true, color: 'rgba(255,255,255,0.4)', fontSize: 9 },
        },
        series: [
          {
            type: 'effectScatter',
            coordinateSystem: 'geo',
            symbolSize: (val: number[]) => Math.max(8, Math.min(28, 6 + (val[2] / maxPhotos) * 22)),
            itemStyle: {
              color: '#84e09d',
              shadowColor: 'rgba(132,224,157,0.6)',
              shadowBlur: 12,
            },
            rippleEffect: { brushType: 'stroke', scale: 2.5 },
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
        const adcode = PROVINCE_TO_ADCODE.get(p.name)
        if (!adcode) return
        setProvinceLoading(true)
        const targetName = p.name
        const myGen = ++loadGenRef.current
        loadProvinceGeoJSON(adcode).then((json) => {
          // 已被更新的 click 取代(用户连点不同省份)— 静默丢弃,
          // 不重置 loading(让最新那次自己结束),不动 province/level 状态
          if (myGen !== loadGenRef.current) return
          setProvinceLoading(false)
          if (!json) return
          setProvinceGeoJSON(json)
          setActiveProvince(targetName)
          setActiveCity(null)
          setLevel('province')
        })
        return
      }
      // 点市(二级地图):钻取到三级
      if (level === 'province' && p.name) {
        setActiveCity(p.name)
        setSelectedSpot(null)
        setLevel('city')
        return
      }
      // 点 spot marker(三级):弹卡片
      if (level === 'city' && p.seriesType === 'effectScatter') {
        const spot = p.data?.spot
        if (spot) setSelectedSpot(spot)
      }
    }
    chart.on('click', handler)
    return () => {
      chart.off('click', handler)
    }
  }, [level])

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

  const handleCrumbClick = useCallback(
    (target: Level) => {
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
    },
    [],
  )

  const dismissSpot = useCallback(() => setSelectedSpot(null), [])

  // 关键 indicator(顶部"X 个省份有照片"展示用)
  const provincesCount = (provincesQ.data ?? []).length

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
          {summary.data && summary.data.pending > 0 ? (
            <span className="archive-geo__progress">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('archive.geo.backfillProgress', {
                resolved: summary.data.resolved,
                total: summary.data.resolved + summary.data.pending,
              })}
            </span>
          ) : null}
          {level === 'country' ? (
            <span className="archive-geo__stat">
              {t('archive.geo.statProvinces', { count: provincesCount })}
            </span>
          ) : null}
        </div>
      </div>

      <div className="archive-geo__canvas">
        <div ref={containerRef} className="archive-geo__chart" />
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
        <SpotDetail
          spot={selectedSpot}
          onClose={dismissSpot}
          onOpenPhoto={onOpenPhoto}
          t={t}
        />
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
  return (
    <div className="archive-geo__spot-overlay" onClick={onClose}>
      <div
        className="archive-geo__spot-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="archive-geo__spot-head">
          <MapPin className="h-4 w-4" />
          <strong>{spot.place ?? t('archive.geo.unknownPlace')}</strong>
          <small>
            {spot.lat.toFixed(5)}°, {spot.lon.toFixed(5)}°
          </small>
        </header>
        <div className="archive-geo__spot-meta">
          <span>{t('archive.geo.tooltipSpecies', { count: spot.species_count })}</span>
          <span>{t('archive.geo.tooltipPhotos', { count: spot.photo_count })}</span>
        </div>
        <div className="archive-geo__spot-grid">
          {spot.photos.map((photo) => (
            <button
              key={photo.photo_id}
              className="archive-geo__spot-thumb"
              onClick={() => onOpenPhoto?.(photo.photo_id)}
              type="button"
            >
              <ThumbnailImage
                alt={photo.file_name}
                className="archive-geo__spot-thumb-img"
                src={photo.thumb_grid ? `plumelens://thumb/${photo.thumb_grid}` : null}
              />
              <span className="archive-geo__spot-thumb-meta">
                <small>{photo.species_zh ?? photo.species_latin ?? photo.file_name}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
