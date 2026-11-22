import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { useTranslation } from 'react-i18next'

import { LIBRARY_DETAIL_KEY } from '@/hooks/use-library'
import { api, ApiError } from '@/lib/api-client'
import { buildPhotoRecordFromRow } from '@/lib/backend-adapter'
import type { PhotoRecord } from '@/lib/workspace-types'

export const PHOTO_REVIEW_KEY = (photoId: string) => ['photo-review', photoId] as const

class ReviewSnapshotChanged extends ApiError {
  constructor() {
    super(409, 'Photo review snapshot changed')
  }
}

/** Review data belongs to this modal and never enters the lightweight workspace. */
export function usePhotoReview(summary: PhotoRecord, t: ReturnType<typeof useTranslation>['t']) {
  const { id, folderId, groupId, inputRevision, reviewRevision, isNewSpecies } = summary
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: [...PHOTO_REVIEW_KEY(id), folderId, inputRevision, reviewRevision],
    queryFn: async ({ signal }) => {
      const { library_id, photo } = await api.photoReview(id, signal)
      if (
        library_id !== folderId ||
        photo.id !== id ||
        (inputRevision !== undefined && photo.input_revision !== inputRevision) ||
        (reviewRevision !== undefined && photo.review_revision !== reviewRevision)
      ) {
        throw new ReviewSnapshotChanged()
      }
      return photo
    },
    // The review row may contain large EXIF and multiple detailed detections.
    gcTime: 0,
    staleTime: reviewRevision ? Infinity : 0,
  })
  const data = query.isError ? undefined : query.data
  const photo = useMemo(
    () => data && { ...buildPhotoRecordFromRow(data, folderId, groupId, t), isNewSpecies },
    [data, folderId, groupId, isNewSpecies, t],
  )
  const revisionChanged = query.error instanceof ReviewSnapshotChanged
  return {
    photo,
    loading: query.isPending,
    error: query.isError,
    revisionChanged,
    onRetry: () => {
      if (revisionChanged) {
        // A new summary identity will mount the corresponding review query.
        void qc.invalidateQueries(
          { queryKey: LIBRARY_DETAIL_KEY(folderId), exact: true },
          { cancelRefetch: false },
        )
      } else {
        void query.refetch({ cancelRefetch: false })
      }
    },
  }
}
