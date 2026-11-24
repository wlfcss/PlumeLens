import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'

import type { SelectionSnapshot } from '@/hooks/use-selection'
import type { LibraryDetail, LibrarySummary, PhotoRow } from '@/lib/api-client'
import { buildFolderRecord, buildFragmentFromDetail } from '@/lib/backend-adapter'
import { benchmarkTrace } from '@/lib/benchmark-trace'
import { applyNewSpeciesMarkers, libraryDetailContentHash } from '@/lib/workspace-projection'
import type { PhotoRecord, WorkspaceSnapshot } from '@/lib/workspace-types'

type Translate = (key: string, options?: Record<string, unknown>) => string

export interface LibraryWorkspaceSnapshot extends WorkspaceSnapshot {
  activeProjection?: {
    detail: LibraryDetail
    selection?: SelectionSnapshot
    translate: Translate
  }
}

interface UseLibraryWorkspaceSyncOptions {
  activeDetail: LibraryDetail | undefined
  activeSelection?: SelectionSnapshot
  allDetails: LibraryDetail[]
  libraries: LibrarySummary[] | undefined
  setWorkspace: Dispatch<SetStateAction<LibraryWorkspaceSnapshot>>
  t: Translate
}

export function useLibraryWorkspaceSync({
  activeDetail,
  activeSelection,
  allDetails,
  libraries,
  setWorkspace,
  t,
}: UseLibraryWorkspaceSyncOptions): void {
  const allDetailsRef = useRef(allDetails)
  allDetailsRef.current = allDetails
  // TanStack reuses equal JSON rows across detail refetches. A new translator needs fresh labels.
  const photoCache = useMemo(() => new WeakMap<PhotoRow, PhotoRecord>(), [t])

  useEffect(() => {
    if (!libraries) return
    const realFolderIds = new Set(libraries.map((library) => library.id))
    setWorkspace((current) => {
      const photos = current.photos.filter((photo) => realFolderIds.has(photo.folderId))
      const groups = current.groups.filter((group) => realFolderIds.has(group.folderId))
      const removed =
        photos.length !== current.photos.length || groups.length !== current.groups.length
      const merged = removed ? applyNewSpeciesMarkers(photos, groups) : current
      return {
        ...current,
        folders: libraries.map(buildFolderRecord),
        photos: merged.photos,
        groups: merged.groups,
        species: [],
        activeProjection:
          current.activeProjection && realFolderIds.has(current.activeProjection.detail.library.id)
            ? current.activeProjection
            : undefined,
      }
    })
  }, [libraries, setWorkspace])

  const allDetailsKey = useMemo(
    () =>
      allDetails
        .map(
          (detail) =>
            `${detail.library.id}:${detail.library.display_name}:${detail.library.status}:${detail.library.last_scanned_at ?? ''}:${detail.library.last_analyzed_at ?? ''}:${detail.photos.length}:${detail.library.analyzed_count}:${libraryDetailContentHash(detail)}`,
        )
        .join('|'),
    [allDetails],
  )

  useEffect(() => {
    const latestDetails = allDetailsRef.current
    if (latestDetails.length === 0) return
    const fragments = latestDetails.map((detail) => buildFragmentFromDetail(detail, t, photoCache))
    const realFolderIdsInDetails = new Set(fragments.map((fragment) => fragment.folder.id))
    setWorkspace((current) => {
      const merged = applyNewSpeciesMarkers(
        [
          ...current.photos.filter((photo) => !realFolderIdsInDetails.has(photo.folderId)),
          ...fragments.flatMap((fragment) => fragment.photos),
        ],
        [
          ...current.groups.filter((group) => !realFolderIdsInDetails.has(group.folderId)),
          ...fragments.flatMap((fragment) => fragment.groups),
        ],
      )
      return {
        ...current,
        folders: current.folders.map((folder) => {
          const updated = fragments.find((fragment) => fragment.folder.id === folder.id)
          return updated ? updated.folder : folder
        }),
        photos: merged.photos,
        groups: merged.groups,
        species: [],
        activeProjection:
          current.activeProjection &&
          !realFolderIdsInDetails.has(current.activeProjection.detail.library.id)
            ? current.activeProjection
            : undefined,
      }
    })
  }, [allDetailsKey, photoCache, setWorkspace, t])

  const fragment = useMemo(() => {
    if (!activeDetail) return undefined
    benchmarkTrace?.markFor('workspace.fragment_start', activeDetail)
    const projected = buildFragmentFromDetail(activeDetail, t, photoCache)
    benchmarkTrace?.markFor('workspace.fragment_end', activeDetail)
    return projected
  }, [activeDetail, photoCache, t])
  useEffect(() => {
    if (!activeDetail || !fragment) return
    const activeProjection = { detail: activeDetail, selection: activeSelection, translate: t }
    setWorkspace((current) => {
      if (
        current.activeProjection?.detail === activeDetail &&
        current.activeProjection.translate === t
      ) {
        if (current.activeProjection.selection === activeSelection) return current
        return { ...current, activeProjection }
      }
      benchmarkTrace?.markFor('workspace.merge_start', activeDetail)
      const merged = applyNewSpeciesMarkers(
        [
          ...current.photos.filter((photo) => photo.folderId !== fragment.folder.id),
          ...fragment.photos,
        ],
        [
          ...current.groups.filter((group) => group.folderId !== fragment.folder.id),
          ...fragment.groups,
        ],
      )
      benchmarkTrace?.markFor('workspace.merge_end', activeDetail)
      return {
        ...current,
        activeProjection,
        photos: merged.photos,
        groups: merged.groups,
      }
    })
  }, [activeDetail, activeSelection, fragment, setWorkspace, t])
}
