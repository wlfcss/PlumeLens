export type AppRoute = 'start' | 'selection' | 'archive'
export type ArchiveTab = 'species' | 'map'
export type FolderStatus =
  | 'idle'
  | 'scanning'
  | 'hashing'
  | 'analyzing_partial'
  | 'ready'
  | 'updating'
  | 'path_missing'
  | 'exporting'
  | 'error'

export type PhotoGrade = 'reject' | 'record' | 'usable' | 'select'
export type SelectionDecision = PhotoGrade | null
export type AnalysisStatus = 'pending' | 'running' | 'done' | 'failed'
export type PhotoGroupType = 'burst' | 'scene' | 'time' | 'species'
export type PoseTagId = 'eye_visible' | 'head_clean' | 'wings_open' | 'perched' | 'multi_bird'
export type ProblemTagId =
  | 'no_bird'
  | 'subject_small'
  | 'eye_soft'
  | 'head_occluded'
  | 'wing_cropped'
  | 'low_species_confidence'
export type SceneTagId = 'perched_portrait' | 'flight_pass' | 'multiple_birds' | 'record_shot'

export interface FolderRecord {
  id: string
  displayName: string
  parentPath: string
  rootPath: string
  status: FolderStatus
  totalCount: number
  analyzedCount: number
  recursive: boolean
  lastOpenedAt: string
  lastScannedAt: string
  lastAnalyzedAt: string | null
}

export interface PhotoGroupRecord {
  id: string
  folderId: string
  title: string
  sceneNumber?: number | null
  startAt?: string | null
  endAt?: string | null
  originalPhotoCount?: number
  groupType: PhotoGroupType
  sceneTag: SceneTagId
  primarySpecies: string | null
  containsNewSpecies: boolean
}

export interface SpeciesCandidate {
  name: string
  latinName?: string | null
  englishName?: string | null
  confidence: number
  recognitionState?: 'recognized' | 'uncertain' | 'unrecognized'
  rejectScore?: number
  top1Top2Margin?: number
}

export interface BirdDetectionRecord {
  index: number
  bbox: { x1: number; y1: number; x2: number; y2: number; confidence: number }
  // 每个 detection 独立的 pose 信息（多鸟图深度复核时切换鸟会用到）。后端
  // BestDetection.pose / BirdDetectionDetail.pose 的镜像。
  // v2 模型(11 关键点)新增字段都是可选,旧 cache 反序列化时为 undefined。
  pose?: {
    bill: { x: number; y: number; confidence: number }
    crown: { x: number; y: number; confidence: number }
    nape: { x: number; y: number; confidence: number }
    left_eye: { x: number; y: number; confidence: number }
    right_eye: { x: number; y: number; confidence: number }
    belly?: { x: number; y: number; confidence: number }
    breast?: { x: number; y: number; confidence: number }
    back?: { x: number; y: number; confidence: number }
    tail?: { x: number; y: number; confidence: number }
    left_wing?: { x: number; y: number; confidence: number }
    right_wing?: { x: number; y: number; confidence: number }
    head_visible: boolean
    eye_visible: boolean
    body_visible?: boolean
    tail_visible?: boolean
    wings_visible?: boolean
    view_angle?: 'frontal' | 'side' | 'back' | 'unknown'
    facing?: 'left' | 'right' | 'unknown'
    posture?: 'perched' | 'flying' | 'unknown'
    posture_confidence?: number
    posture_method?: 'classifier' | 'heuristic'
  } | null
  speciesName: string | null
  speciesLatinName: string | null
  speciesEnglishName?: string | null
  speciesCandidates: SpeciesCandidate[]
  manualSpecies: boolean
  isBest: boolean
  // 每个 detection 独立的 species_source（多鸟图混合可见性的关键 — 后端 v6 schema）。
  // 羽迹聚合按 detection 维度，model_unconfirmed 的 detection 不进羽迹，
  // 直到用户在深度复核确认。
  speciesSource?: 'none' | 'model' | 'model_unconfirmed' | 'manual' | 'group_consensus' | 'conflict'
}

export interface AfOverlayPoint {
  index?: number
  x: number
  y: number
  width?: number
  height?: number
  bounds?: { x1: number; y1: number; x2: number; y2: number }
  in_focus?: boolean
  selected?: boolean
}

export interface AfOverlay {
  provider?: string
  mode?: number
  kind: 'point' | 'expanded' | 'zone' | 'whole_area' | 'unknown'
  source?: 'in_focus' | 'selected' | 'legacy'
  center: { x: number; y: number }
  bounds?: { x1: number; y1: number; x2: number; y2: number }
  points?: AfOverlayPoint[]
  focused_points?: AfOverlayPoint[]
  selected_points?: AfOverlayPoint[]
  focused_count?: number
  selected_count?: number
  point_count?: number
}

export interface PhotoRecord {
  id: string
  folderId: string
  groupId: string
  fileName: string
  /** 主 entry 的绝对磁盘路径。前端用于"用 Topaz/PS 打开"等外部应用集成。
   *  fixture/test 数据不填;真后端走 backend-adapter 从 row.file_path 透传。 */
  filePath?: string
  shotAt: string
  camera: string
  lens: string
  speciesName: string | null
  speciesLatinName: string | null
  speciesEnglishName?: string | null
  manualSpecies?: boolean
  // model_unconfirmed: 物种 reject head 不确定，或鸟头/关键特征不完整但模型给了识别。
  // 不进羽迹，用户在深度复核确认后升级为 manual。group consensus 可覆盖为 group_consensus。
  speciesSource?: 'none' | 'model' | 'model_unconfirmed' | 'manual' | 'group_consensus' | 'conflict'
  modelSpeciesName?: string | null
  modelSpeciesLatinName?: string | null
  groupSpeciesName?: string | null
  groupSpeciesLatinName?: string | null
  groupSpeciesConfidence?: number | null
  groupSpeciesSupport?: number | null
  groupSpeciesEvidence?: number | null
  groupSpeciesTotal?: number | null
  speciesConflict?: boolean
  speciesCandidates: SpeciesCandidate[]
  birdDetections?: BirdDetectionRecord[]
  isNewSpecies: boolean
  birdCount: number
  grade: PhotoGrade
  decision: SelectionDecision
  finalScore: number | null
  semanticScore: number | null
  technicalScore: number | null
  poseScore: number | null
  analysisStatus: AnalysisStatus
  /** 失败原因的语义 code(broken_image / invalid_image / file_missing / timeout / unknown),
   *  前端按 locale 查 i18n 显示。仅在 analysisStatus === 'failed' 时有意义。 */
  analysisErrorCode?: string | null
  /** 原始错误消息(英文 PIL/rawpy),没匹配上 code 时 fallback 显示。 */
  analysisError?: string | null
  poseTags: PoseTagId[]
  problemTags: ProblemTagId[]
  sceneTag: SceneTagId
  caption: string
  previewGradient: string
  placeholderGradient?: string
  thumbGridUrl?: string | null
  boxes: Array<{ x: number; y: number; w: number; h: number }>
  // 深度复核字段（fixture/test 数据不填，真后端在 backend-adapter 注入）
  imageWidth?: number | null
  imageHeight?: number | null
  thumbPreviewUrl?: string | null
  exif?: Record<string, unknown> | null
  bestBbox?: { x1: number; y1: number; x2: number; y2: number; confidence: number } | null
  // best detection 的 pose;v2 模型新增字段都是 optional 兼容旧 cache。
  bestPose?: {
    bill: { x: number; y: number; confidence: number }
    crown: { x: number; y: number; confidence: number }
    nape: { x: number; y: number; confidence: number }
    left_eye: { x: number; y: number; confidence: number }
    right_eye: { x: number; y: number; confidence: number }
    belly?: { x: number; y: number; confidence: number }
    breast?: { x: number; y: number; confidence: number }
    back?: { x: number; y: number; confidence: number }
    tail?: { x: number; y: number; confidence: number }
    left_wing?: { x: number; y: number; confidence: number }
    right_wing?: { x: number; y: number; confidence: number }
    head_visible: boolean
    eye_visible: boolean
    body_visible?: boolean
    tail_visible?: boolean
    wings_visible?: boolean
    view_angle?: 'frontal' | 'side' | 'back' | 'unknown'
    facing?: 'left' | 'right' | 'unknown'
    posture?: 'perched' | 'flying' | 'unknown'
    posture_confidence?: number
    posture_method?: 'classifier' | 'heuristic'
  } | null
  // 对焦点（原图坐标系，Canon AFInfo MakerNote 解析得到）
  bestAfPoint?: { x: number; y: number } | null
  bestAfArea?: AfOverlay | null
  // JPG/RAW 同名 pair 的同伴文件信息（scanner v7+ 识别）。无 pair 时全 null。
  // 主 entry 走 fileName,companion 不入单独 photo,UI 在卡片右下角显示 "+CR3" 等。
  companionPath?: string | null
  companionFormat?: string | null // CR3 / NEF / ARW / JPG ...
  companionSize?: number | null // 字节数
  country?: string | null
  province?: string | null
  city?: string | null
  district?: string | null
  place?: string | null
}

export interface SpeciesRecord {
  id: string
  name: string
  latinName: string
  englishName?: string | null
  coverGradient: string
  imageUrl?: string | null
  photoCount: number
  firstSeenAt: string
  lastSeenAt: string
  bestScore: number | null
  newSightings: number
  regions: string[]
  summary: string
  collected?: boolean
  protectLevel?: string | null
  iucn?: string | null
  familyName?: string | null
  isTrained?: boolean
  inChinaV12?: boolean
  catalogSource?: 'china_v12' | 'model_extra' | 'uncatalogued'
}

export interface WorkspaceSnapshot {
  folders: FolderRecord[]
  groups: PhotoGroupRecord[]
  photos: PhotoRecord[]
  species: SpeciesRecord[]
}
