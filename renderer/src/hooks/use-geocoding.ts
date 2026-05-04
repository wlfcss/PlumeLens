/**
 * Reverse geocoding — 把 GPS 坐标查成可读地名(国/省/市/POI)。
 *
 * 后端 chain:amap → baidu → tencent → nominatim → 离线 GeoNames cities1000。
 * 前端只用 React Query 缓存(内存,会话级),staleTime=Infinity 因为坐标永远映射
 * 到同一地址,不需要 refetch。坐标 round 到 4 位小数(~11m 精度)做 query key,
 * 同一场景的多张照片共用一个查询。
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api } from '@/lib/api-client'

const ROUND_PRECISION = 4 // 4 decimal places ≈ 11m,同场景照片复用查询

function roundCoord(value: number): number {
  return Math.round(value * 10 ** ROUND_PRECISION) / 10 ** ROUND_PRECISION
}

export function useReverseGeocode(lat: number | null | undefined, lon: number | null | undefined) {
  const { i18n } = useTranslation()
  const lang = i18n.language || 'zh-CN'
  const enabled = lat !== null && lat !== undefined && lon !== null && lon !== undefined

  const roundedLat = enabled ? roundCoord(lat) : null
  const roundedLon = enabled ? roundCoord(lon) : null

  return useQuery({
    queryKey: ['geocoding', 'reverse', roundedLat, roundedLon, lang],
    queryFn: () => api.reverseGeocode(lat as number, lon as number, lang),
    enabled,
    staleTime: Infinity, // 同坐标 → 同地址,永久缓存
    gcTime: 30 * 60 * 1000, // 30 分钟空闲清掉,避免长会话内存堆积
    retry: 1, // 后端 chain 已经多重 fallback,前端再重试 1 次足够
  })
}
