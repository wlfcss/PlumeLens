import type { useTranslation } from 'react-i18next'

import { poseTagKey, problemTagKey } from '@/lib/i18n-keys'
import type { PhotoRecord } from '@/lib/workspace-types'

export function TagCluster({
  photo,
  t,
}: {
  photo: PhotoRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <div className="tag-cluster">
      {photo.problemTags.length === 0 ? (
        <span className="chip chip--success">{t('selection.inspector.cleanFrame')}</span>
      ) : (
        photo.problemTags.map((tag) => (
          <span className="chip chip--warning" key={tag}>
            {t(problemTagKey(tag))}
          </span>
        ))
      )}
      {photo.poseTags.map((tag) => (
        <span className="chip" key={tag}>
          {t(poseTagKey(tag))}
        </span>
      ))}
    </div>
  )
}
