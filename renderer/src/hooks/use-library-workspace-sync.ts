import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'

import type { LibraryDetail, LibrarySummary } from '@/lib/api-client'
import { buildFolderRecord, buildFragmentFromDetail } from '@/lib/backend-adapter'
import { applyNewSpeciesMarkers, libraryDetailContentHash } from '@/lib/workspace-projection'
import type { WorkspaceSnapshot } from '@/lib/workspace-types'

type Translate = (key: string, options?: Record<string, unknown>) => string

interface UseLibraryWorkspaceSyncOptions {
  activeDetail: LibraryDetail | undefined
  allDetails: LibraryDetail[]
  libraries: LibrarySummary[] | undefined
  setWorkspace: Dispatch<SetStateAction<WorkspaceSnapshot>>
  t: Translate
}

export function useLibraryWorkspaceSync({
  activeDetail,
  allDetails,
  libraries,
  setWorkspace,
  t,
}: UseLibraryWorkspaceSyncOptions): void {
  const allDetailsRef = useRef(allDetails)
  allDetailsRef.current = allDetails

  useEffect(() => {
    if (!libraries) return
    const realFolderIds = new Set(libraries.map((library) => library.id))
    setWorkspace((current) => {
      const merged = applyNewSpeciesMarkers(
        current.photos.filter((photo) => realFolderIds.has(photo.folderId)),
        current.groups.filter((group) => realFolderIds.has(group.folderId)),
      )
      return {
        folders: libraries.map(buildFolderRecord),
        photos: merged.photos,
        groups: merged.groups,
        species: [],
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
    const fragments = latestDetails.map((detail) => buildFragmentFromDetail(detail, t))
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
        folders: current.folders.map((folder) => {
          const updated = fragments.find((fragment) => fragment.folder.id === folder.id)
          return updated ? updated.folder : folder
        }),
        photos: merged.photos,
        groups: merged.groups,
        species: [],
      }
    })
  }, [allDetailsKey, setWorkspace, t])

  useEffect(() => {
    if (!activeDetail) return
    const fragment = buildFragmentFromDetail(activeDetail, t)
    setWorkspace((current) => {
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
      return {
        ...current,
        folders: current.folders.map((folder) =>
          folder.id === fragment.folder.id ? fragment.folder : folder,
        ),
        photos: merged.photos,
        groups: merged.groups,
      }
    })
  }, [activeDetail, setWorkspace, t])
}
