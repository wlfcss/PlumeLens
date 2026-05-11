import type { MouseEvent as ReactMouseEvent } from 'react'

/**
 * 在系统默认浏览器中打开外链(经 Electron preload 注入的 IPC),阻止
 * <a> 默认导航(避免在 Electron 渲染进程内部跳转污染应用状态)。
 */
export function openExternalLink(
  event: ReactMouseEvent<HTMLAnchorElement>,
  url: string,
): void {
  const opener = window.plumelens?.openExternalUrl
  if (!opener) return
  event.preventDefault()
  void opener(url)
}
