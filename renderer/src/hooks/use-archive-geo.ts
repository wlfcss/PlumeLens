/**
 * 羽迹三级地图数据 hooks。
 * 后端已经把 reverse_geocoding 持久化到 photos 表,这些 endpoint 都是 SQL 聚合,
 * 响应快(~10ms)。一级数据启动后立即可用,二/三级按用户钻取按需 fetch。
 */
import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api-client'

export function useGeoSummary() {
  return useQuery({
    queryKey: ['archive', 'geo', 'summary'],
    queryFn: () => api.geoSummary(),
    refetchInterval: 5_000, // backfill 期间进度变化,5s 轮询
    staleTime: 0,
  })
}

export function useGeoProvinces() {
  return useQuery({
    queryKey: ['archive', 'geo', 'provinces'],
    queryFn: () => api.geoProvinces(),
    refetchInterval: 10_000, // backfill 期间数据增长,10s 拉一次
    staleTime: 5_000,
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
