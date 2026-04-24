export type AppRoute = 'start' | 'selection' | 'archive'
export type ArchiveTab = 'photos' | 'species'
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

export type SelectionDecision = 'unreviewed' | 'selected' | 'maybe' | 'rejected'
export type PhotoGrade = 'reject' | 'record' | 'usable' | 'select'
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
  groupType: PhotoGroupType
  sceneTag: SceneTagId
  primarySpecies: string | null
  containsNewSpecies: boolean
}

export interface SpeciesCandidate {
  name: string
  confidence: number
}

export interface PhotoRecord {
  id: string
  folderId: string
  groupId: string
  fileName: string
  shotAt: string
  camera: string
  lens: string
  speciesName: string | null
  speciesLatinName: string | null
  speciesCandidates: SpeciesCandidate[]
  isNewSpecies: boolean
  birdCount: number
  grade: PhotoGrade
  decision: SelectionDecision
  finalScore: number | null
  semanticScore: number | null
  technicalScore: number | null
  poseScore: number | null
  analysisStatus: AnalysisStatus
  poseTags: PoseTagId[]
  problemTags: ProblemTagId[]
  sceneTag: SceneTagId
  caption: string
  previewGradient: string
  boxes: Array<{ x: number; y: number; w: number; h: number }>
}

export interface SpeciesRecord {
  id: string
  name: string
  latinName: string
  coverGradient: string
  photoCount: number
  firstSeenAt: string
  lastSeenAt: string
  bestScore: number
  newSightings: number
  regions: string[]
  summary: string
}

export interface WorkspaceSnapshot {
  folders: FolderRecord[]
  groups: PhotoGroupRecord[]
  photos: PhotoRecord[]
  species: SpeciesRecord[]
}

type PhotoSeed = Omit<
  PhotoRecord,
  | 'id'
  | 'folderId'
  | 'groupId'
  | 'fileName'
  | 'shotAt'
  | 'camera'
  | 'lens'
  | 'speciesLatinName'
>

interface FolderSeed {
  folder: Omit<FolderRecord, 'totalCount' | 'analyzedCount'>
  groups: Array<{
    id: string
    title: string
    groupType: PhotoGroupType
    sceneTag: SceneTagId
    primarySpecies: string | null
    containsNewSpecies: boolean
    photos: PhotoSeed[]
  }>
}

const cameraBody = 'OM-1 Mark II'
const mainLens = 'M.Zuiko 150-400mm F4.5'

const folderSeeds: FolderSeed[] = [
  {
    folder: {
      id: 'folder-chongming-dawn',
      displayName: '崇明东滩·晨拍',
      parentPath: '/Volumes/Birds/2026/04-23',
      rootPath: '/Volumes/Birds/2026/04-23/崇明东滩·晨拍',
      status: 'ready',
      recursive: true,
      lastOpenedAt: '2026-04-23T12:42:00+08:00',
      lastScannedAt: '2026-04-23T12:36:00+08:00',
      lastAnalyzedAt: '2026-04-23T12:41:00+08:00',
    },
    groups: [
      {
        id: 'group-reed-heron',
        title: '06:42 芦苇丛停栖组',
        groupType: 'burst',
        sceneTag: 'perched_portrait',
        primarySpecies: '池鹭',
        containsNewSpecies: false,
        photos: [
          {
            speciesName: '池鹭',
            isNewSpecies: false,
            birdCount: 1,
            grade: 'select',
            decision: 'selected',
            finalScore: 0.91,
            semanticScore: 0.84,
            technicalScore: 0.93,
            poseScore: 0.92,
            analysisStatus: 'done',
            poseTags: ['eye_visible', 'head_clean', 'perched'],
            problemTags: [],
            sceneTag: 'perched_portrait',
            caption: '眼神最准，颈部姿态完整',
            previewGradient:
              'linear-gradient(135deg, rgba(165,189,129,0.85), rgba(61,79,54,0.88) 60%, rgba(15,20,17,0.92))',
            boxes: [{ x: 26, y: 12, w: 38, h: 66 }],
            speciesCandidates: [
              { name: '池鹭', confidence: 0.94 },
              { name: '夜鹭', confidence: 0.18 },
            ],
          },
          {
            speciesName: '池鹭',
            isNewSpecies: false,
            birdCount: 1,
            grade: 'usable',
            decision: 'maybe',
            finalScore: 0.77,
            semanticScore: 0.74,
            technicalScore: 0.8,
            poseScore: 0.72,
            analysisStatus: 'done',
            poseTags: ['head_clean', 'perched'],
            problemTags: ['eye_soft'],
            sceneTag: 'perched_portrait',
            caption: '姿态接近，但眼部略软',
            previewGradient:
              'linear-gradient(135deg, rgba(156,180,132,0.84), rgba(68,87,61,0.9) 56%, rgba(14,18,17,0.95))',
            boxes: [{ x: 29, y: 14, w: 35, h: 63 }],
            speciesCandidates: [
              { name: '池鹭', confidence: 0.92 },
              { name: '夜鹭', confidence: 0.2 },
            ],
          },
          {
            speciesName: '池鹭',
            isNewSpecies: false,
            birdCount: 1,
            grade: 'record',
            decision: 'rejected',
            finalScore: 0.49,
            semanticScore: 0.52,
            technicalScore: 0.47,
            poseScore: 0.44,
            analysisStatus: 'done',
            poseTags: ['perched'],
            problemTags: ['subject_small', 'eye_soft'],
            sceneTag: 'perched_portrait',
            caption: '主体稍小，细节不够稳',
            previewGradient:
              'linear-gradient(135deg, rgba(132,151,119,0.72), rgba(59,77,58,0.92) 52%, rgba(15,17,17,0.95))',
            boxes: [{ x: 33, y: 20, w: 26, h: 49 }],
            speciesCandidates: [
              { name: '池鹭', confidence: 0.86 },
              { name: '夜鹭', confidence: 0.28 },
            ],
          },
        ],
      },
      {
        id: 'group-tern-flight',
        title: '07:13 低空掠水组',
        groupType: 'burst',
        sceneTag: 'flight_pass',
        primarySpecies: '须浮鸥',
        containsNewSpecies: true,
        photos: [
          {
            speciesName: '须浮鸥',
            isNewSpecies: true,
            birdCount: 1,
            grade: 'select',
            decision: 'selected',
            finalScore: 0.88,
            semanticScore: 0.79,
            technicalScore: 0.86,
            poseScore: 0.96,
            analysisStatus: 'done',
            poseTags: ['eye_visible', 'wings_open'],
            problemTags: [],
            sceneTag: 'flight_pass',
            caption: '展翅完整，是本次疑似新增种',
            previewGradient:
              'linear-gradient(135deg, rgba(112,130,149,0.8), rgba(78,104,127,0.88) 48%, rgba(17,21,25,0.96))',
            boxes: [{ x: 18, y: 18, w: 61, h: 40 }],
            speciesCandidates: [
              { name: '须浮鸥', confidence: 0.81 },
              { name: '黑翅长脚鹬', confidence: 0.34 },
              { name: '白鹭', confidence: 0.12 },
            ],
          },
          {
            speciesName: '须浮鸥',
            isNewSpecies: true,
            birdCount: 1,
            grade: 'usable',
            decision: 'maybe',
            finalScore: 0.73,
            semanticScore: 0.69,
            technicalScore: 0.71,
            poseScore: 0.79,
            analysisStatus: 'done',
            poseTags: ['wings_open'],
            problemTags: ['low_species_confidence'],
            sceneTag: 'flight_pass',
            caption: '翅形漂亮，但分类置信略低',
            previewGradient:
              'linear-gradient(135deg, rgba(122,140,162,0.78), rgba(69,91,112,0.9) 50%, rgba(17,20,23,0.96))',
            boxes: [{ x: 19, y: 16, w: 58, h: 42 }],
            speciesCandidates: [
              { name: '须浮鸥', confidence: 0.68 },
              { name: '燕鸥', confidence: 0.42 },
            ],
          },
          {
            speciesName: '须浮鸥',
            isNewSpecies: false,
            birdCount: 1,
            grade: 'record',
            decision: 'rejected',
            finalScore: 0.45,
            semanticScore: 0.43,
            technicalScore: 0.51,
            poseScore: 0.39,
            analysisStatus: 'done',
            poseTags: ['wings_open'],
            problemTags: ['wing_cropped', 'eye_soft'],
            sceneTag: 'flight_pass',
            caption: '翼尖截断，适合作记录片',
            previewGradient:
              'linear-gradient(135deg, rgba(106,122,143,0.75), rgba(66,82,103,0.9) 52%, rgba(18,20,23,0.98))',
            boxes: [{ x: 22, y: 23, w: 48, h: 33 }],
            speciesCandidates: [
              { name: '须浮鸥', confidence: 0.63 },
              { name: '燕鸥', confidence: 0.38 },
            ],
          },
        ],
      },
      {
        id: 'group-sandpipers',
        title: '07:42 泥滩多鸟组',
        groupType: 'scene',
        sceneTag: 'multiple_birds',
        primarySpecies: '青脚鹬',
        containsNewSpecies: false,
        photos: [
          {
            speciesName: '青脚鹬',
            isNewSpecies: false,
            birdCount: 3,
            grade: 'usable',
            decision: 'maybe',
            finalScore: 0.71,
            semanticScore: 0.75,
            technicalScore: 0.68,
            poseScore: 0.69,
            analysisStatus: 'done',
            poseTags: ['multi_bird', 'eye_visible'],
            problemTags: [],
            sceneTag: 'multiple_birds',
            caption: '主体关系清楚，适合作组图',
            previewGradient:
              'linear-gradient(135deg, rgba(143,130,113,0.75), rgba(90,78,64,0.92) 55%, rgba(17,16,15,0.98))',
            boxes: [
              { x: 18, y: 28, w: 24, h: 31 },
              { x: 40, y: 23, w: 22, h: 36 },
              { x: 60, y: 26, w: 18, h: 28 },
            ],
            speciesCandidates: [
              { name: '青脚鹬', confidence: 0.89 },
              { name: '红脚鹬', confidence: 0.22 },
            ],
          },
          {
            speciesName: '青脚鹬',
            isNewSpecies: false,
            birdCount: 2,
            grade: 'record',
            decision: 'rejected',
            finalScore: 0.43,
            semanticScore: 0.46,
            technicalScore: 0.44,
            poseScore: 0.38,
            analysisStatus: 'done',
            poseTags: ['multi_bird'],
            problemTags: ['subject_small'],
            sceneTag: 'multiple_birds',
            caption: '关系成立，但主体都偏小',
            previewGradient:
              'linear-gradient(135deg, rgba(152,139,120,0.72), rgba(87,75,63,0.94) 53%, rgba(19,18,16,0.98))',
            boxes: [
              { x: 24, y: 29, w: 19, h: 28 },
              { x: 52, y: 26, w: 17, h: 27 },
            ],
            speciesCandidates: [
              { name: '青脚鹬', confidence: 0.78 },
              { name: '红脚鹬', confidence: 0.31 },
            ],
          },
          {
            speciesName: null,
            isNewSpecies: false,
            birdCount: 0,
            grade: 'reject',
            decision: 'rejected',
            finalScore: 0.12,
            semanticScore: null,
            technicalScore: null,
            poseScore: null,
            analysisStatus: 'done',
            poseTags: [],
            problemTags: ['no_bird'],
            sceneTag: 'record_shot',
            caption: '无有效主体，已建议淘汰',
            previewGradient:
              'linear-gradient(135deg, rgba(79,94,108,0.66), rgba(39,46,55,0.96) 58%, rgba(14,14,15,1))',
            boxes: [],
            speciesCandidates: [],
          },
        ],
      },
    ],
  },
  {
    folder: {
      id: 'folder-nanhui-wind',
      displayName: '南汇嘴·海风',
      parentPath: '/Volumes/Birds/2026/04-22',
      rootPath: '/Volumes/Birds/2026/04-22/南汇嘴·海风',
      status: 'analyzing_partial',
      recursive: true,
      lastOpenedAt: '2026-04-23T11:02:00+08:00',
      lastScannedAt: '2026-04-23T10:48:00+08:00',
      lastAnalyzedAt: '2026-04-23T11:00:00+08:00',
    },
    groups: [
      {
        id: 'group-egret-shore',
        title: '08:11 潮线上镜组',
        groupType: 'scene',
        sceneTag: 'perched_portrait',
        primarySpecies: '白鹭',
        containsNewSpecies: false,
        photos: [
          {
            speciesName: '白鹭',
            isNewSpecies: false,
            birdCount: 1,
            grade: 'usable',
            decision: 'selected',
            finalScore: 0.81,
            semanticScore: 0.76,
            technicalScore: 0.84,
            poseScore: 0.8,
            analysisStatus: 'done',
            poseTags: ['eye_visible', 'head_clean', 'perched'],
            problemTags: [],
            sceneTag: 'perched_portrait',
            caption: '海风方向好，白羽层次保住了',
            previewGradient:
              'linear-gradient(135deg, rgba(193,205,214,0.82), rgba(104,123,140,0.9) 52%, rgba(18,22,28,0.98))',
            boxes: [{ x: 31, y: 13, w: 33, h: 67 }],
            speciesCandidates: [
              { name: '白鹭', confidence: 0.91 },
              { name: '中白鹭', confidence: 0.26 },
            ],
          },
          {
            speciesName: '白鹭',
            isNewSpecies: false,
            birdCount: 1,
            grade: 'record',
            decision: 'maybe',
            finalScore: 0.52,
            semanticScore: 0.51,
            technicalScore: 0.56,
            poseScore: 0.47,
            analysisStatus: 'done',
            poseTags: ['perched'],
            problemTags: ['head_occluded'],
            sceneTag: 'perched_portrait',
            caption: '风姿不错，但头部被浪花遮掉',
            previewGradient:
              'linear-gradient(135deg, rgba(171,186,197,0.77), rgba(86,101,115,0.92) 55%, rgba(18,21,25,0.98))',
            boxes: [{ x: 35, y: 18, w: 28, h: 60 }],
            speciesCandidates: [
              { name: '白鹭', confidence: 0.88 },
              { name: '中白鹭', confidence: 0.21 },
            ],
          },
        ],
      },
      {
        id: 'group-kestrel-pass',
        title: '08:34 防波堤掠过组',
        groupType: 'burst',
        sceneTag: 'flight_pass',
        primarySpecies: '红隼',
        containsNewSpecies: false,
        photos: [
          {
            speciesName: '红隼',
            isNewSpecies: false,
            birdCount: 1,
            grade: 'usable',
            decision: 'maybe',
            finalScore: 0.74,
            semanticScore: 0.7,
            technicalScore: 0.72,
            poseScore: 0.82,
            analysisStatus: 'done',
            poseTags: ['wings_open', 'eye_visible'],
            problemTags: ['low_species_confidence'],
            sceneTag: 'flight_pass',
            caption: '过翼形态很漂亮，值得再看一轮',
            previewGradient:
              'linear-gradient(135deg, rgba(130,111,89,0.78), rgba(77,61,48,0.92) 55%, rgba(16,14,12,0.99))',
            boxes: [{ x: 17, y: 19, w: 62, h: 40 }],
            speciesCandidates: [
              { name: '红隼', confidence: 0.64 },
              { name: '游隼', confidence: 0.44 },
            ],
          },
          {
            speciesName: '红隼',
            isNewSpecies: false,
            birdCount: 1,
            grade: 'record',
            decision: 'unreviewed',
            finalScore: 0.39,
            semanticScore: 0.41,
            technicalScore: 0.38,
            poseScore: 0.37,
            analysisStatus: 'running',
            poseTags: ['wings_open'],
            problemTags: ['eye_soft', 'wing_cropped'],
            sceneTag: 'flight_pass',
            caption: '分析中，初步判断不如上一张',
            previewGradient:
              'linear-gradient(135deg, rgba(124,106,88,0.74), rgba(74,60,49,0.92) 52%, rgba(15,13,12,0.99))',
            boxes: [{ x: 23, y: 22, w: 51, h: 34 }],
            speciesCandidates: [
              { name: '红隼', confidence: 0.53 },
              { name: '游隼', confidence: 0.41 },
            ],
          },
          {
            speciesName: null,
            isNewSpecies: false,
            birdCount: 0,
            grade: 'reject',
            decision: 'unreviewed',
            finalScore: null,
            semanticScore: null,
            technicalScore: null,
            poseScore: null,
            analysisStatus: 'pending',
            poseTags: [],
            problemTags: [],
            sceneTag: 'record_shot',
            caption: '等待分析结果',
            previewGradient:
              'linear-gradient(135deg, rgba(69,74,87,0.7), rgba(28,31,36,0.96) 60%, rgba(12,12,13,1))',
            boxes: [],
            speciesCandidates: [],
          },
        ],
      },
    ],
  },
  {
    folder: {
      id: 'folder-jiuduansha-return',
      displayName: '九段沙·回程',
      parentPath: '/Volumes/Birds/2026/04-21',
      rootPath: '/Volumes/Birds/2026/04-21/九段沙·回程',
      status: 'updating',
      recursive: true,
      lastOpenedAt: '2026-04-22T21:14:00+08:00',
      lastScannedAt: '2026-04-22T21:12:00+08:00',
      lastAnalyzedAt: '2026-04-22T21:13:00+08:00',
    },
    groups: [
      {
        id: 'group-grebe-water',
        title: '16:19 回程水面组',
        groupType: 'time',
        sceneTag: 'record_shot',
        primarySpecies: '小鸊鷉',
        containsNewSpecies: false,
        photos: [
          {
            speciesName: '小鸊鷉',
            isNewSpecies: false,
            birdCount: 1,
            grade: 'record',
            decision: 'rejected',
            finalScore: 0.46,
            semanticScore: 0.49,
            technicalScore: 0.43,
            poseScore: 0.45,
            analysisStatus: 'done',
            poseTags: ['eye_visible'],
            problemTags: ['subject_small'],
            sceneTag: 'record_shot',
            caption: '记录片，回程保留样本',
            previewGradient:
              'linear-gradient(135deg, rgba(107,133,152,0.75), rgba(55,78,93,0.92) 58%, rgba(17,20,22,0.98))',
            boxes: [{ x: 39, y: 30, w: 18, h: 19 }],
            speciesCandidates: [
              { name: '小鸊鷉', confidence: 0.82 },
              { name: '凤头鸊鷉', confidence: 0.21 },
            ],
          },
          {
            speciesName: null,
            isNewSpecies: false,
            birdCount: 0,
            grade: 'reject',
            decision: 'rejected',
            finalScore: 0.08,
            semanticScore: null,
            technicalScore: null,
            poseScore: null,
            analysisStatus: 'done',
            poseTags: [],
            problemTags: ['no_bird'],
            sceneTag: 'record_shot',
            caption: '空片',
            previewGradient:
              'linear-gradient(135deg, rgba(72,90,104,0.72), rgba(35,43,51,0.96) 58%, rgba(13,14,15,1))',
            boxes: [],
            speciesCandidates: [],
          },
        ],
      },
    ],
  },
  {
    folder: {
      id: 'folder-west-creek-side',
      displayName: '西溪湿地·侧拍',
      parentPath: '/Volumes/Birds/2026/04-18',
      rootPath: '/Volumes/Birds/2026/04-18/西溪湿地·侧拍',
      status: 'path_missing',
      recursive: true,
      lastOpenedAt: '2026-04-19T20:31:00+08:00',
      lastScannedAt: '2026-04-19T20:12:00+08:00',
      lastAnalyzedAt: '2026-04-19T20:28:00+08:00',
    },
    groups: [
      {
        id: 'group-kingfisher-side',
        title: '14:57 枝头侧拍组',
        groupType: 'species',
        sceneTag: 'perched_portrait',
        primarySpecies: '翠鸟',
        containsNewSpecies: false,
        photos: [
          {
            speciesName: '翠鸟',
            isNewSpecies: false,
            birdCount: 1,
            grade: 'select',
            decision: 'selected',
            finalScore: 0.89,
            semanticScore: 0.82,
            technicalScore: 0.9,
            poseScore: 0.92,
            analysisStatus: 'done',
            poseTags: ['eye_visible', 'head_clean', 'perched'],
            problemTags: [],
            sceneTag: 'perched_portrait',
            caption: '路径失效前保留的代表作',
            previewGradient:
              'linear-gradient(135deg, rgba(67,148,173,0.8), rgba(40,105,117,0.9) 50%, rgba(10,18,21,0.98))',
            boxes: [{ x: 28, y: 20, w: 34, h: 42 }],
            speciesCandidates: [
              { name: '翠鸟', confidence: 0.97 },
              { name: '蓝翡翠', confidence: 0.09 },
            ],
          },
        ],
      },
    ],
  },
]

const speciesRecords: SpeciesRecord[] = [
  {
    id: 'species-night-heron',
    name: '池鹭',
    latinName: 'Ardeola bacchus',
    coverGradient:
      'linear-gradient(135deg, rgba(164,189,127,0.85), rgba(58,76,48,0.9) 55%, rgba(14,16,14,0.98))',
    photoCount: 18,
    firstSeenAt: '2026-03-28T06:52:00+08:00',
    lastSeenAt: '2026-04-23T06:42:00+08:00',
    bestScore: 0.91,
    newSightings: 0,
    regions: ['上海', '崇明东滩'],
    summary: '浅水区常见个体，本季第一批进入婚羽状态',
  },
  {
    id: 'species-whiskered-tern',
    name: '须浮鸥',
    latinName: 'Chlidonias hybrida',
    coverGradient:
      'linear-gradient(135deg, rgba(118,138,159,0.78), rgba(67,88,107,0.92) 50%, rgba(15,18,21,0.99))',
    photoCount: 6,
    firstSeenAt: '2026-04-23T07:13:00+08:00',
    lastSeenAt: '2026-04-23T07:13:00+08:00',
    bestScore: 0.88,
    newSightings: 1,
    regions: ['上海', '东滩潮间带'],
    summary: '本周第一次在本地样点记录到较高置信的掠水个体',
  },
  {
    id: 'species-egret',
    name: '白鹭',
    latinName: 'Egretta garzetta',
    coverGradient:
      'linear-gradient(135deg, rgba(192,206,215,0.82), rgba(102,122,139,0.92) 52%, rgba(18,21,28,0.98))',
    photoCount: 14,
    firstSeenAt: '2026-04-05T08:10:00+08:00',
    lastSeenAt: '2026-04-22T08:11:00+08:00',
    bestScore: 0.81,
    newSightings: 0,
    regions: ['上海', '南汇嘴'],
    summary: '海边样点高频出现，逆光时容易保不住羽毛层次',
  },
  {
    id: 'species-kingfisher',
    name: '翠鸟',
    latinName: 'Alcedo atthis',
    coverGradient:
      'linear-gradient(135deg, rgba(64,148,172,0.82), rgba(37,104,116,0.92) 52%, rgba(11,18,21,0.99))',
    photoCount: 9,
    firstSeenAt: '2026-03-16T14:21:00+08:00',
    lastSeenAt: '2026-04-18T14:57:00+08:00',
    bestScore: 0.89,
    newSightings: 0,
    regions: ['杭州', '西溪湿地'],
    summary: '羽色极出片，适合在羽迹中作为代表作展示',
  },
]

let importCounter = 1

function hydrateSeed(seed: FolderSeed): WorkspaceSnapshot {
  const groups: PhotoGroupRecord[] = []
  const photos: PhotoRecord[] = []

  for (const group of seed.groups) {
    groups.push({
      id: group.id,
      folderId: seed.folder.id,
      title: group.title,
      groupType: group.groupType,
      sceneTag: group.sceneTag,
      primarySpecies: group.primarySpecies,
      containsNewSpecies: group.containsNewSpecies,
    })

    group.photos.forEach((photo, index) => {
      photos.push({
        ...photo,
        id: `${group.id}-photo-${index + 1}`,
        folderId: seed.folder.id,
        groupId: group.id,
        fileName: `${group.title.replaceAll(' ', '-')}-${index + 1}.ORF`,
        shotAt: new Date(
          new Date(seed.folder.lastScannedAt).getTime() + (index + 1) * 60_000,
        ).toISOString(),
        camera: cameraBody,
        lens: mainLens,
        speciesLatinName:
          speciesRecords.find((item) => item.name === photo.speciesName)?.latinName ?? null,
      })
    })
  }

  const totalCount = photos.length
  const analyzedCount = photos.filter((photo) => photo.analysisStatus === 'done').length

  return {
    folders: [
      {
        ...seed.folder,
        totalCount,
        analyzedCount,
      },
    ],
    groups,
    photos,
    species: [],
  }
}

export function createInitialWorkspace(): WorkspaceSnapshot {
  const hydrated = folderSeeds.map(hydrateSeed)

  return {
    folders: hydrated.flatMap((item) => item.folders),
    groups: hydrated.flatMap((item) => item.groups),
    photos: hydrated.flatMap((item) => item.photos),
    species: speciesRecords,
  }
}

export function createImportedFolder(path: string): WorkspaceSnapshot {
  const slug = `imported-${importCounter++}`
  const name = path.split('/').filter(Boolean).at(-1) ?? `未命名文件夹-${slug}`
  const parentPath = path.split('/').slice(0, -1).join('/') || '/'
  const now = new Date().toISOString()
  const base = hydrateSeed({
    folder: {
      id: `folder-${slug}`,
      displayName: name,
      parentPath,
      rootPath: path,
      status: 'scanning',
      recursive: true,
      lastOpenedAt: now,
      lastScannedAt: now,
      lastAnalyzedAt: null,
    },
    groups: [
      {
        id: `group-${slug}-start`,
        title: '新导入文件夹',
        groupType: 'time',
        sceneTag: 'record_shot',
        primarySpecies: null,
        containsNewSpecies: false,
        photos: [
          {
            speciesName: null,
            isNewSpecies: false,
            birdCount: 0,
            grade: 'reject',
            decision: 'unreviewed',
            finalScore: null,
            semanticScore: null,
            technicalScore: null,
            poseScore: null,
            analysisStatus: 'pending',
            poseTags: [],
            problemTags: [],
            sceneTag: 'record_shot',
            caption: '新导入文件夹，等待扫描与分析',
            previewGradient:
              'linear-gradient(135deg, rgba(92,92,92,0.68), rgba(38,38,38,0.92) 56%, rgba(12,12,12,1))',
            boxes: [],
            speciesCandidates: [],
          },
        ],
      },
    ],
  })

  return base
}
