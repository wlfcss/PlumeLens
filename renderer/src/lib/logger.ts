/**
 * 渲染进程日志门面 — 把散落的 console.* 收口到一处。
 *
 * dev:照常打 console(便于 DevTools 看堆栈);
 * prod:warn/error 仍打 console(Electron 的 stderr 由 main 进程收集到日志文件,
 *   未来要接 Sentry 也是统一改这里);info/debug 在 prod 下静默。
 *
 * 不引入第三方日志库 — Electron 渲染进程 console 已经被 main 进程的
 * stdio 转发器写到 ~/Library/Logs/plumelens/renderer.log,这层只是
 * 给以后接 telemetry / Sentry 留一个收口。
 */

const isDev = import.meta.env.DEV

type LogArg = unknown

export const logger = {
  debug(...args: LogArg[]): void {
    if (!isDev) return
    console.debug(...args)
  },
  info(...args: LogArg[]): void {
    if (!isDev) return
    console.info(...args)
  },
  warn(...args: LogArg[]): void {
    console.warn(...args)
  },
  error(...args: LogArg[]): void {
    console.error(...args)
  },
}
