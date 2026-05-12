/**
 * 应用级错误边界 — 子树 render 抛出未捕获异常时,降级到"出错信息 + 重试"占位,
 * 防止白屏。
 *
 * 范围:包在 AppShell 内层(EngineStatusBanner 之下、各页面之上),仅捕获
 * 渲染期错误;后台 hook(query/SSE/IPC) 的 promise reject 不会在这里冒泡,
 * 那些走自己的错误状态(react-query / EngineStatusBanner 已处理)。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import type { useTranslation } from 'react-i18next'

import { logger } from '@/lib/logger'

interface Props {
  children: ReactNode
  t: ReturnType<typeof useTranslation>['t']
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error('[ErrorBoundary] uncaught render error', error, info.componentStack)
  }

  private handleRetry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      const { t } = this.props
      return (
        <div className="error-boundary-fallback" role="alert">
          <div>
            <h2>{t('errors.renderFailed.title')}</h2>
            <p>{t('errors.renderFailed.body')}</p>
            <pre className="error-boundary-fallback__detail">
              {this.state.error.message}
            </pre>
            <button className="button-primary" onClick={this.handleRetry} type="button">
              {t('errors.renderFailed.retry')}
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
