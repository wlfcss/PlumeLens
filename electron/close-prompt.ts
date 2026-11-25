/**
 * Frameless dark-theme close confirmation modal window for Electron main process.
 */

import { BrowserWindow, dialog } from 'electron'

type ClosePromptContent = {
  title: string
  detail: string
  confirmLabel: string
}

const CLOSE_PROMPT_SCHEME = 'plumelens-close-prompt:'
const SKIP_CLOSE_CONFIRM = process.env['PLUMELENS_E2E_DISABLE_CLOSE_CONFIRM'] === '1'

let closePromptOpen = false

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function buildClosePromptHtml(content: ClosePromptContent): string {
  const title = escapeHtml(content.title)
  const detail = escapeHtml(content.detail)
  const confirmLabel = escapeHtml(content.confirmLabel)

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline';"
    />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #050505;
        --panel: #101010;
        --panel-low: #080808;
        --fg: #f4f4f4;
        --muted: #a3a3a3;
        --border: rgba(255, 255, 255, 0.14);
        --border-strong: rgba(255, 255, 255, 0.28);
        --accent: #ff1f2d;
      }
      * { box-sizing: border-box; }
      html, body {
        width: 100%; height: 100%; margin: 0; overflow: hidden;
        background: transparent; color: var(--fg);
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC',
          'Hiragino Sans GB', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif;
        text-rendering: optimizeLegibility; user-select: none; -webkit-font-smoothing: antialiased;
      }
      .overlay {
        display: grid; width: 100vw; height: 100vh; place-items: center; padding: 24px;
        background: radial-gradient(circle at 50% 46%, rgba(255, 255, 255, 0.04), transparent 34%), rgba(0, 0, 0, 0.58);
        backdrop-filter: blur(8px);
      }
      .panel {
        width: min(374px, calc(100vw - 48px)); border: 1px solid var(--border); border-radius: 18px;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.018)),
          linear-gradient(180deg, var(--panel), var(--panel-low));
        box-shadow: 0 30px 90px rgba(0, 0, 0, 0.58), 0 0 0 1px rgba(0, 0, 0, 0.72), inset 0 1px 0 rgba(255, 255, 255, 0.055);
        padding: 18px;
      }
      h1 { margin: 0; color: var(--fg); font-size: 17px; font-weight: 650; line-height: 1.25; }
      p { margin: 9px 0 0; color: var(--muted); font-size: 13px; font-weight: 450; line-height: 1.62; }
      .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 18px; }
      .action {
        display: inline-flex; height: 36px; align-items: center; justify-content: center;
        border: 1px solid var(--border); border-radius: 9px; color: var(--fg);
        font-size: 13px; font-weight: 600; text-decoration: none;
        transition: border-color 140ms ease, background-color 140ms ease, color 140ms ease, transform 140ms ease;
      }
      .action:focus-visible { outline: 0; box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.44); }
      .action:hover { transform: translateY(-1px); }
      .action--primary { border-color: rgba(255, 255, 255, 0.82); background: #f2f2f2; color: var(--bg); }
      .action--secondary { background: rgba(255, 255, 255, 0.045); color: color-mix(in srgb, var(--fg) 86%, transparent); }
      .action--secondary:hover {
        border-color: color-mix(in srgb, var(--accent) 44%, var(--border-strong));
        background: color-mix(in srgb, var(--accent) 9%, rgba(255, 255, 255, 0.045));
        color: var(--fg);
      }
    </style>
  </head>
  <body>
    <main class="overlay">
      <section class="panel" role="dialog" aria-modal="true" aria-labelledby="close-title">
        <h1 id="close-title">${title}</h1>
        <p>${detail}</p>
        <div class="actions">
          <a class="action action--primary" href="${CLOSE_PROMPT_SCHEME}//cancel">继续使用</a>
          <a class="action action--secondary" href="${CLOSE_PROMPT_SCHEME}//confirm">${confirmLabel}</a>
        </div>
      </section>
    </main>
  </body>
</html>`
}

async function showClosePromptWindow(
  owner: BrowserWindow,
  content: ClosePromptContent,
): Promise<boolean> {
  if (owner.isDestroyed()) return false
  if (owner.isMinimized()) owner.restore()
  if (!owner.isVisible()) owner.show()

  const bounds = owner.getBounds()
  if (bounds.width < 320 || bounds.height < 200 || bounds.x < -10_000 || bounds.y < -10_000) {
    const result = await dialog.showMessageBox(owner, {
      type: 'question',
      title: content.title,
      message: content.title,
      detail: content.detail,
      buttons: ['继续使用', content.confirmLabel],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    return result.response === 1
  }
  const promptWindow = new BrowserWindow({
    parent: owner,
    modal: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    movable: false,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    backgroundColor: '#00000000',
    hasShadow: false,
    title: content.title,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const promptUrl = `data:text/html;charset=utf-8,${encodeURIComponent(buildClosePromptHtml(content))}`

  return new Promise((resolve) => {
    let settled = false

    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
      if (!promptWindow.isDestroyed()) promptWindow.close()
    }

    promptWindow.webContents.on('will-navigate', (event, target) => {
      if (target.startsWith('data:text/html')) return
      event.preventDefault()
      if (!target.startsWith(CLOSE_PROMPT_SCHEME)) return
      const action = new URL(target).host
      settle(action === 'confirm')
    })
    promptWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        settle(false)
      }
    })
    promptWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    promptWindow.once('closed', () => settle(false))
    promptWindow.once('ready-to-show', () => {
      if (owner.isDestroyed()) {
        settle(false)
        return
      }
      promptWindow.show()
      promptWindow.focus()
    })
    promptWindow.loadURL(promptUrl).catch(() => settle(false))
  })
}

export async function requestCloseConfirmation(owner: BrowserWindow | null): Promise<boolean> {
  if (SKIP_CLOSE_CONFIRM) return true
  if (closePromptOpen) return false
  closePromptOpen = true

  const content: ClosePromptContent = {
    title: '确定要退出鉴翎吗？',
    detail: '本地引擎会停止；历史记录和已完成的筛选会保留。',
    confirmLabel: '退出',
  }
  const activeOwner = owner && !owner.isDestroyed() ? owner : null

  try {
    if (activeOwner) return await showClosePromptWindow(activeOwner, content)
    const result = await dialog.showMessageBox({
      type: 'question',
      title: content.title,
      message: content.title,
      detail: content.detail,
      buttons: ['继续使用', content.confirmLabel],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    return result.response === 1
  } finally {
    closePromptOpen = false
  }
}
