import { useTranslation } from 'react-i18next'
import { useBackendHealth } from '@/hooks/use-backend'

export default function App() {
  const { t } = useTranslation()
  const { isReady, isError } = useBackendHealth()

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">{t('app.title')}</h1>
        <p className="text-muted-foreground">{t('app.subtitle')}</p>
        <div className="flex items-center justify-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              isReady ? 'bg-green-500' : isError ? 'bg-red-500' : 'bg-yellow-500 animate-pulse'
            }`}
          />
          <span className="text-sm text-muted-foreground">
            {isReady
              ? t('status.connected')
              : isError
                ? t('status.error')
                : t('status.connecting')}
          </span>
        </div>
      </div>
    </div>
  )
}
