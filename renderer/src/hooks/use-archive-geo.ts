/**
 * 羽迹三级地图数据 hooks。
 * 后端已经把 reverse_geocoding 持久化到 photos 表,这些 endpoint 都是 SQL 聚合,
 * 响应快(~10ms)。一级数据启动后立即可用,二/三级按用户钻取按需 fetch。
 */
import { useQuery } from '@tanstack/react-query'

import { api, type GeoSummary } from '@/lib/api-client'

/**
 * Summary 永远开 5s 轮询太浪费 — backfill 一旦完成(pending=0)就停掉。新照片入
 * 库时 location_backfill 会重新创 pending,届时下一次手动 trigger 或 useGeoSummary
 * 重新挂载会 reset 轮询。
 */
export function useGeoSummary() {
  return useQuery<GeoSummary>({
    queryKey: ['archive', 'geo', 'summary'],
    queryFn: () => api.geoSummary(),
    // backfill 进行中(pending>0)继续 5s 轮询;否则停止轮询(false)。
    refetchInterval: (query) => (query.state.data?.pending ?? 0) > 0 ? 5_000 : false,
    staleTime: 0,
  })
}

/**
 * Provinces 需要在 backfill 期间持续拉(数据还在增长),完成后停止。
 * 入参 pending 由调用方(羽迹页)从 useGeoSummary().data.pending 传进来 — hook 间不
 * 直接耦合,避免做反向 query 订阅。pending 未知时按 backfill 中处理(保守)。
 */
export function useGeoProvinces(pending?: number) {
  const isBackfilling = pending === undefined || pending > 0
  return useQuery({
    queryKey: ['archive', 'geo', 'provinces'],
    queryFn: () => api.geoProvinces(),
    // backfill 中 10s 拉一次,完成后停轮询(SSE / window focus 触发刷新即可)
    refetchInterval: isBackfilling ? 10_000 : false,
    refetchOnWindowFocus: true,
    staleTime: isBackfilling ? 5_000 : 60_000,
  })
}

export function useGeoCities(province: string | null) {
  return useQuery({
    queryKey: ['archive', 'geo', 'cities', province],
    queryFn: () => api.geoCities(province!),
    enabled: !!province,
    staleTime: 30_000,
  })
}

export function useGeoSpots(province: string | null, city: string | null) {
  return useQuery({
    queryKey: ['archive', 'geo', 'spots', province, city],
    queryFn: () => api.geoSpots(province!, city!),
    enabled: !!province && !!city,
    staleTime: 30_000,
  })
}
