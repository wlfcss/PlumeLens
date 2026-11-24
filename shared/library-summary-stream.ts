export const LIBRARY_SUMMARY_BATCH_MEDIA_TYPE = 'application/x-ndjson'
export const LIBRARY_SUMMARY_COMPACT_FORMAT = 'compact-v1'

export function normalizeLibraryRootPrefix(rootPath: string | null | undefined): string {
  if (!rootPath) return ''
  const sep = rootPath.includes('\\') && !rootPath.includes('/') ? '\\' : '/'
  return rootPath.endsWith('/') || rootPath.endsWith('\\') ? rootPath : `${rootPath}${sep}`
}

function hydrateCompactPose(raw: Record<string, unknown> | null | undefined) {
  if (!raw || typeof raw !== 'object') return null
  return {
    head_visible: Boolean(raw.head_visible),
    eye_visible: Boolean(raw.eye_visible),
    body_visible: Boolean(raw.body_visible),
    tail_visible: Boolean(raw.tail_visible),
    wings_visible: Boolean(raw.wings_visible),
    view_angle: (raw.view_angle as string | undefined) ?? 'unknown',
    facing: (raw.facing as string | undefined) ?? 'unknown',
    posture: (raw.posture as string | undefined) ?? 'unknown',
    posture_confidence: typeof raw.posture_confidence === 'number' ? raw.posture_confidence : 0,
    posture_method: (raw.posture_method as string | undefined) ?? 'heuristic',
  }
}

function hydrateCompactDetection(raw: Record<string, unknown>, includeIsBest: boolean) {
  const base: Record<string, unknown> = {
    index: typeof raw.index === 'number' ? raw.index : 0,
    bbox: raw.bbox,
    pose: hydrateCompactPose(raw.pose as Record<string, unknown> | null | undefined),
    quality: (raw.quality as Record<string, number> | null | undefined) ?? null,
    species: (raw.species as string | null | undefined) ?? null,
    species_latin: (raw.species_latin as string | null | undefined) ?? null,
    species_english: (raw.species_english as string | null | undefined) ?? null,
    manual_species: Boolean(raw.manual_species),
    species_source: (raw.species_source as string | undefined) ?? 'none',
    candidate_confidence:
      typeof raw.candidate_confidence === 'number' ? raw.candidate_confidence : null,
    candidate_recognition_state:
      (raw.candidate_recognition_state as string | null | undefined) ?? null,
  }
  if (includeIsBest) {
    base.is_best = Boolean(raw.is_best)
  }
  return base
}

/**
 * Losslessly expand a compact-v1 NDJSON summary row back into a full PhotoRow
 * shape before TanStack Query structural sharing.
 */
export function hydrateCompactSummaryRow<T>(
  raw: Record<string, unknown>,
  rootPrefix: string,
): T {
  const rawDetections = Array.isArray(raw.detections)
    ? (raw.detections as Record<string, unknown>[]).map((det) =>
        hydrateCompactDetection(det, true),
      )
    : null
  const bestFromDetections = rawDetections
    ? (rawDetections.find((det) => det.is_best) ?? rawDetections[0] ?? null)
    : null
  let bestDetection: Record<string, unknown> | null = null
  if (raw.best_detection && typeof raw.best_detection === 'object') {
    bestDetection = hydrateCompactDetection(raw.best_detection as Record<string, unknown>, false)
  } else if (bestFromDetections) {
    const rest = { ...bestFromDetections }
    delete rest.is_best
    bestDetection = rest
  }

  const filePath =
    typeof raw.file_path === 'string'
      ? raw.file_path
      : typeof raw.rel_path === 'string'
        ? `${rootPrefix}${raw.rel_path}`
        : ''
  const companionPath =
    typeof raw.companion_path === 'string'
      ? raw.companion_path
      : typeof raw.rel_companion_path === 'string'
        ? `${rootPrefix}${raw.rel_companion_path}`
        : null

  return {
    id: raw.id,
    file_path: filePath,
    file_name: raw.file_name,
    input_revision: typeof raw.input_revision === 'number' ? raw.input_revision : 0,
    review_revision: (raw.review_revision as string | null | undefined) ?? null,
    file_hash: (raw.file_hash as string | null | undefined) ?? null,
    format: (raw.format as string | null | undefined) ?? null,
    width: typeof raw.width === 'number' ? raw.width : null,
    height: typeof raw.height === 'number' ? raw.height : null,
    thumb_grid: (raw.thumb_grid as string | null | undefined) ?? null,
    thumb_preview: (raw.thumb_preview as string | null | undefined) ?? null,
    companion_path: companionPath,
    companion_format: (raw.companion_format as string | null | undefined) ?? null,
    companion_size: typeof raw.companion_size === 'number' ? raw.companion_size : null,
    country: (raw.country as string | null | undefined) ?? null,
    province: (raw.province as string | null | undefined) ?? null,
    city: (raw.city as string | null | undefined) ?? null,
    district: (raw.district as string | null | undefined) ?? null,
    place: (raw.place as string | null | undefined) ?? null,
    created_at: raw.created_at,
    shot_at: raw.shot_at,
    scene_id: typeof raw.scene_id === 'number' ? raw.scene_id : null,
    pipeline_version: (raw.pipeline_version as string | null | undefined) ?? null,
    grade: (raw.grade as string | null | undefined) ?? null,
    quality_score: typeof raw.quality_score === 'number' ? raw.quality_score : null,
    bird_count: typeof raw.bird_count === 'number' ? raw.bird_count : null,
    species: (raw.species as string | null | undefined) ?? null,
    species_latin: (raw.species_latin as string | null | undefined) ?? null,
    manual_species: Boolean(raw.manual_species),
    species_source: (raw.species_source as string | undefined) ?? 'none',
    model_species: (raw.model_species as string | null | undefined) ?? null,
    model_species_latin: (raw.model_species_latin as string | null | undefined) ?? null,
    group_species: (raw.group_species as string | null | undefined) ?? null,
    group_species_latin: (raw.group_species_latin as string | null | undefined) ?? null,
    group_species_confidence:
      typeof raw.group_species_confidence === 'number' ? raw.group_species_confidence : null,
    group_species_support:
      typeof raw.group_species_support === 'number' ? raw.group_species_support : null,
    group_species_evidence:
      typeof raw.group_species_evidence === 'number' ? raw.group_species_evidence : null,
    group_species_total:
      typeof raw.group_species_total === 'number' ? raw.group_species_total : null,
    species_conflict: Boolean(raw.species_conflict),
    decision: (raw.decision as string | null | undefined) ?? null,
    analysis_status: (raw.analysis_status as string | undefined) ?? 'pending',
    analysis_error_code: (raw.analysis_error_code as string | null | undefined) ?? null,
    analysis_error: (raw.analysis_error as string | null | undefined) ?? null,
    exif: (raw.exif as Record<string, unknown> | null | undefined) ?? null,
    best_detection: bestDetection,
    detections: rawDetections,
  } as T
}

/** Decode complete UTF-8 records regardless of transport chunk boundaries. */
export async function readSummaryLines(
  body: ReadableStream<Uint8Array>,
  receive: (line: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const text = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const decoded = text.decode(value, { stream: true })
      let start = 0
      let newline = decoded.indexOf('\n', start)
      while (newline !== -1) {
        const chunk = decoded.slice(start, newline)
        receive(pending ? pending + chunk : chunk)
        pending = ''
        start = newline + 1
        newline = decoded.indexOf('\n', start)
      }
      if (start < decoded.length) {
        pending += start === 0 ? decoded : decoded.slice(start)
      }
    }
    if (pending + text.decode()) throw new Error('Incomplete library summary record')
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}
