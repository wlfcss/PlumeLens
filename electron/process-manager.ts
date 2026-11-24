import { ChildProcess, spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'fs'
import { app } from 'electron'
import { join } from 'path'
import { readUserSettings } from './user-settings'
import { EngineStartupProtocol } from './engine-startup-protocol'
import { engineStartupTimeout } from '../shared/engine-request-timeout'
import { terminateEngine } from './engine-shutdown'
import { getClientLogger, getScopedLogger } from './logger'

/**
 * 拉起并守护 Python engine 子进程。
 *
 * Dev：`uv run uvicorn engine.main:app --port 0`（uvicorn 直接打 stderr）
 * Prod：PyInstaller frozen binary `plumelens-engine`（自己 stdout 打印 `PLUMELENS_PORT <n>`）
 *
 * 端口握手协议：engine 启动后会打印 `PLUMELENS_PORT <n>`（stdout），收到即可知道
 * 实际监听端口；不依赖 uvicorn 的 banner 文本（更稳定，frozen 下 uvicorn 输出格式可能变）。
 *
 * 日志持久化（仅在用户开启本地日志后落盘）：
 * - engine 子进程 stderr → logs/engine.stderr.{startup_ts}.log（每次启动新文件，
 *   保留最近 MAX_STARTUP_LOGS 个，旧的自动删）。这是 PyInstaller / uvicorn /
 *   segfault 等 raw 输出唯一落点，崩溃时关键。
 * - process-manager 自身事件 → logs/client.jsonl（由 electron/logger.ts 统一管理）。
 * - 后端 structlog 事件单独走 logs/engine.jsonl（由 engine.core.logging 配置，
 *   通过 PLUMELENS_DEVICE_ID / PLUMELENS_SESSION_ID 与客户端日志关联）。
 */

const MAX_STARTUP_LOGS = 10
const ENGINE_READY_TIMEOUT_MS = engineStartupTimeout(process.platform)

export class ProcessManager extends EventEmitter {
  private process: ChildProcess | null = null
  private url: string | null = null
  private restartCount = 0
  private readonly maxRestarts = 3
  private healthInterval: ReturnType<typeof setInterval> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private readyTimer: { proc: ChildProcess; timer: ReturnType<typeof setTimeout> } | null = null
  private readonly authToken = randomBytes(32).toString('hex')
  // 关停标志：stop() 设为 true，handleCrash 与 setTimeout 都会检查，
  // 防止应用关闭中残留的 setTimeout 触发 spawn 出孤儿 engine。
  private stopped = false
  private lifecycleGeneration = 0
  private readonly terminating = new Map<ChildProcess, Promise<void>>()
  // 持久化日志根目录（{userData}/logs），lazy 创建
  private readonly logsDir = join(app.getPath('userData'), 'logs')
  private readonly pmLog = getScopedLogger('engine-pm')
  private readonly healthLog = getScopedLogger('engine-health')

  // graceful degrade: species 推理设备。auto = 让后端自选(MPS on Mac);
  // cpu = 显式强制 CPU。累计崩溃 N 次后下次 spawn 自动切到 cpu — PyTorch MPS
  // 在多 worker 并发场景会 abort,降级 CPU 慢 ~8× 但绝对稳。一旦切到 CPU,
  // 本进程生命周期内不会切回 auto(避免反复重启)。
  private speciesDevice: 'auto' | 'cpu' = 'auto'
  // ⚠ 必须用永不重置的累积计数:restartCount 在 ready 后会清 0(line ~204),
  // 用它做 fallback 判定永远 < threshold。totalCrashCount 只在 handleCrash 内 ++,
  // 不被 ready 重置,真实反映"应用启动以来累计崩了 N 次"。
  private totalCrashCount = 0
  // 累计崩 >= 这个值时切 CPU。设 2 = 第 1 次给 GPU 一次机会(可能偶发),第 2 次明确是
  // 系统性问题(MPS 并发 / 资源耗尽),自动降级避免反复打扰用户。
  private readonly cpuFallbackThreshold = 2

  constructor() {
    super()
    getClientLogger()?.registerSecret(this.authToken)
  }

  getUrl(): string | null {
    return this.url
  }

  getAuthToken(): string {
    return this.authToken
  }

  /**
   * 同步客户端日志开关/级别/设备标识到正在运行的 Python Engine，无需重启模型。
   */
  async syncLoggingToEngine(options: {
    enabled: boolean
    level: 'info' | 'debug'
    deviceId?: string | null
    sessionId?: string
    reopen?: boolean
  }): Promise<boolean> {
    if (!this.url) return false
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    try {
      const response = await fetch(`${this.url}/settings/logging`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          enabled: options.enabled,
          level: options.level.toUpperCase(),
          ...(options.deviceId ? { device_id: options.deviceId } : {}),
          ...(options.sessionId ? { session_id: options.sessionId } : {}),
          reopen: Boolean(options.reopen),
        }),
        signal: ctrl.signal,
      })
      return response.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 以内部认证令牌拉取 Engine 只读诊断 JSON（用于导出日志包时拉取 /health 或 /diagnostics/db-summary）。
   */
  async fetchEngineJson(path: string, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
    if (!this.url) return null
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.url}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.authToken}` },
        signal: ctrl.signal,
      })
      if (!response.ok) return null
      const payload = (await response.json()) as unknown
      if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
        return payload as Record<string, unknown>
      }
      return null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** 当前 engine 子进程 PID(spawn 时 detached:true,pgid == pid)。
   * 'exit' handler 用此 PID 走同步 process.kill(-pid, 'SIGKILL') —
   * 事件循环已停的场景下,异步 setTimeout 兜底不会 fire,只能同步杀。 */
  getEnginePid(): number | undefined {
    return this.process?.pid
  }

  getEnginePids(): number[] {
    return [
      ...new Set(
        [this.process, ...this.terminating.keys()].flatMap((proc) =>
          proc?.pid !== undefined && proc.exitCode === null && proc.signalCode === null
            ? [proc.pid]
            : [],
        ),
      ),
    ]
  }

  /** 确保 logs/ 目录存在；返回 true 表示可以写文件日志。失败不阻断启动。 */
  private ensureLogsDir(): boolean {
    try {
      if (!existsSync(this.logsDir)) mkdirSync(this.logsDir, { recursive: true })
      return true
    } catch (err) {
      this.pmLog.warn('cannot_create_logs_dir', undefined, err)
      return false
    }
  }

  /** 统一写入主进程结构化日志 client.jsonl（遵循用户日志开关与脱敏策略）。 */
  private writeElectronLog(
    message: string,
    level: 'info' | 'warn' | 'error' = 'info',
    meta?: Record<string, unknown>,
  ): void {
    const logger = getClientLogger()
    if (logger) {
      logger.log({
        level,
        process: 'main',
        scope: 'engine-pm',
        category: level === 'error' ? 'error' : 'lifecycle',
        event: message,
        meta,
      })
      return
    }
    this.pmLog[level](message, meta)
  }

  /** 删除多余的 engine.stderr.{ts}.log，保留最近 MAX_STARTUP_LOGS 个。 */
  private pruneOldStderrLogs(): void {
    if (!this.ensureLogsDir()) return
    try {
      const files = readdirSync(this.logsDir)
        .filter((f) => /^engine\.stderr\.[\dT]+Z\.log$/.test(f))
        .map((f) => ({ name: f, mtime: statSync(join(this.logsDir, f)).mtime.getTime() }))
        .sort((a, b) => b.mtime - a.mtime) // 最新在前
      for (const old of files.slice(MAX_STARTUP_LOGS)) {
        try {
          unlinkSync(join(this.logsDir, old.name))
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  /** 为本次 spawn 新建 engine.stderr.{startup_ts}.log 写入流（仅当用户开启日志时落盘）。 */
  private openStderrLog(): WriteStream | null {
    const logger = getClientLogger()
    if (logger && !logger.isEnabled()) return null
    if (!this.ensureLogsDir()) return null
    const ts = new Date().toISOString().replace(/[-:.]/g, '')
    const path = join(this.logsDir, `engine.stderr.${ts}.log`)
    try {
      const stream = createWriteStream(path, { flags: 'a', encoding: 'utf-8', mode: 0o600 })
      stream.on('error', (err) =>
        this.writeElectronLog('engine_stderr_log_unavailable', 'warn', { message: err.message }),
      )
      stream.write(`# === engine spawn @ ${new Date().toISOString()} ===\n`)
      return stream
    } catch (err) {
      this.pmLog.warn('cannot_open_stderr_log', undefined, err)
      return null
    }
  }

  private clearReadyTimer(proc?: ChildProcess): void {
    if (!this.readyTimer) return
    if (proc && this.readyTimer.proc !== proc) return
    clearTimeout(this.readyTimer.timer)
    this.readyTimer = null
  }

  async start(): Promise<void> {
    if (this.stopped || this.process !== null) return
    const generation = this.lifecycleGeneration
    const isDev = !app.isPackaged

    // 持久化日志：本次 spawn 一个新 engine.stderr.log（保留最近 10 个）。
    // 用闭包局部变量而不是 class field — 防止 restart() 时新 spawn 覆盖
    // 老 spawn 的 stream ref,导致老 proc exit 写到错误的文件。
    this.pruneOldStderrLogs()
    const stderrStream: WriteStream | null = this.openStderrLog()
    const closeStderrStream = (): void => {
      if (stderrStream && !stderrStream.writableEnded && !stderrStream.destroyed) {
        stderrStream.end()
      }
    }

    let command: string
    let args: string[]
    let cwd: string
    const clientLog = getClientLogger()
    const loggingEnabled = clientLog ? clientLog.isEnabled() : false
    const logLevel = clientLog ? clientLog.getLevel().toUpperCase() : 'INFO'
    const deviceId = clientLog?.getDeviceId()
    const sessionId = clientLog?.getSessionId()

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      ...(process.platform === 'win32'
        ? {
            OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? '4',
            MKL_NUM_THREADS: process.env.MKL_NUM_THREADS ?? '4',
          }
        : {}),
      PLUMELENS_PORT: '0', // kernel 分配空闲端口
      // 让 engine 的数据库/缩略图目录和主进程 plumelens://thumb 协议读的目录一致。
      // 之前 dev 模式 engine 默认写 ~/.plumelens，而 Electron 协议读 userData，
      // DB 里有 thumb 路径但文件在另一个根目录，选片页就会频繁显示空缩略图。
      PLUMELENS_DATA_DIR: app.getPath('userData'),
      PLUMELENS_API_TOKEN: this.authToken,
      PLUMELENS_PARENT_PID: String(process.pid),
      PLUMELENS_LOGGING_ENABLED: loggingEnabled ? '1' : '0',
      PLUMELENS_LOG_LEVEL: logLevel,
      ...(deviceId ? { PLUMELENS_DEVICE_ID: deviceId } : {}),
      ...(sessionId ? { PLUMELENS_SESSION_ID: sessionId } : {}),
    }

    // graceful degrade: 已经决定切 CPU 后,后续每次 spawn 都强制传这个 env。
    // engine 的 Settings.species_provider 会从 PLUMELENS_SPECIES_PROVIDER 读。
    if (this.speciesDevice === 'cpu') {
      env.PLUMELENS_SPECIES_PROVIDER = 'cpu'
    }

    // 用户自带的 reverse geocoding API keys — 通过 user-settings 模块读,内部走
    // safeStorage 异步解密(macOS Keychain / Win DPAPI / Linux libsecret)。注入 env
    // 给后端 geocoder chain 使用(amap → baidu → tencent → nominatim → offline)。
    // 失败/缺失静默忽略 — 走离线 cities1000 兜底,不影响启动。
    try {
      const userSettings = await readUserSettings()
      if (userSettings.amapKey) {
        env.PLUMELENS_AMAP_KEY = userSettings.amapKey
        clientLog?.registerSecret(userSettings.amapKey)
      }
      if (userSettings.baiduAk) {
        env.PLUMELENS_BAIDU_AK = userSettings.baiduAk
        clientLog?.registerSecret(userSettings.baiduAk)
      }
      if (userSettings.tencentKey) {
        env.PLUMELENS_TENCENT_KEY = userSettings.tencentKey
        clientLog?.registerSecret(userSettings.tencentKey)
      }
    } catch (err) {
      this.writeElectronLog('read_user_settings_failed', 'warn', {
        message: (err as Error).message,
      })
    }

    if (this.stopped || this.process !== null || generation !== this.lifecycleGeneration) {
      closeStderrStream()
      return
    }

    if (isDev) {
      command = process.env.PLUMELENS_PYTHON || 'uv'
      args = process.env.PLUMELENS_PYTHON ? ['-m', 'engine'] : ['run', 'python', '-m', 'engine']
      cwd = join(__dirname, '../../')
    } else {
      // PyInstaller frozen binary: Resources/plumelens-engine/plumelens-engine
      command = join(
        process.resourcesPath,
        'plumelens-engine',
        process.platform === 'win32' ? 'plumelens-engine.exe' : 'plumelens-engine',
      )
      args = []
      cwd = join(process.resourcesPath, 'plumelens-engine')
      // Production：模型文件由 electron-builder extraResources 放在 Resources/models/
      env.PLUMELENS_MODELS_DIR = join(process.resourcesPath, 'models')
      // Strict 模式：缺 IQA 模型直接启动失败，不允许伪造 0.5 中性分。
      // 不在这里设 dev 也跑不起来（开发期还没下载所有模型时方便迭代）。
      env.PLUMELENS_REQUIRE_IQA = '1'
      // Production 必须启用一次性 API token。后端启动期会校验这个 guard，
      // 避免打包态因 env 注入异常而退回到无鉴权 loopback API。
      env.PLUMELENS_REQUIRE_API_TOKEN = '1'
    }

    // detached: true + 后续按进程组 kill (-pid) → 杀掉整个 engine 子树（含 torch /
    // transformers / pyarrow 内部 spawn 的 helper 进程）。否则 SIGTERM 只杀主进程，
    // helper（如 multiprocessing resource_tracker）会成为孤儿继续吃 RAM。
    const spawnStartedAt = Date.now()
    this.writeElectronLog('engine_spawn', 'info', {
      dev: isDev,
      speciesDevice: this.speciesDevice,
    })
    // 闭包局部 proc — 关键防 restart 竞态:老 proc exit handler 闭包到自己的 proc,
    // 触发时检查 `this.process !== proc` 就能判断"是否已被新 spawn 替换",
    // 防止老 proc 的 exit 把新 spawn 的 url/state 给清掉(误报 fatal banner)。
    let proc: ChildProcess
    try {
      proc = spawn(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      })
    } catch (err) {
      closeStderrStream()
      const message = err instanceof Error ? err.message : String(err)
      this.writeElectronLog('engine_spawn_threw', 'error', { message })
      this.emit('error', `Engine spawn 失败: ${message}`)
      return
    }
    this.process = proc
    const writeStderr = (data: string | Buffer): void => {
      if (stderrStream && !stderrStream.writableEnded && !stderrStream.destroyed)
        stderrStream.write(data)
    }
    // 'exit' can precede trailing stdout/stderr. Close the log only after both pipes close.
    proc.once('close', () => {
      closeStderrStream()
    })

    const protocol = new EngineStartupProtocol((url) => {
      if (this.process !== proc || this.url || this.stopped) return
      this.clearReadyTimer(proc)
      this.url = url
      this.restartCount = 0
      const startupMs = Date.now() - spawnStartedAt
      getClientLogger()?.log({
        level: 'info',
        process: 'main',
        scope: 'engine-pm',
        category: 'task_metric',
        event: 'engine_startup_timing',
        meta: {
          stages_ms: { engine_spawn_to_ready: startupMs },
          speciesDevice: this.speciesDevice,
          dev: isDev,
        },
      })
      this.emit('ready', url)
      this.startHealthCheck()
    })
    const readyTimer = setTimeout(() => {
      if (this.readyTimer?.proc === proc) this.readyTimer = null
      if (this.process !== proc || this.url) return
      const discoveredPort = protocol.getPort()
      const pendingUrl = discoveredPort ? `http://127.0.0.1:${discoveredPort}` : 'none'
      const message = `Engine 启动超时（${Math.round(ENGINE_READY_TIMEOUT_MS / 1000)} 秒内未就绪），请打开诊断日志查看模型加载或初始化卡死原因。`
      this.writeElectronLog(
        `engine startup timeout waiting for PLUMELENS_READY pendingUrl=${pendingUrl}`,
      )
      writeStderr(
        `\n# === startup timeout @ ${new Date().toISOString()} pendingUrl=${pendingUrl} ===\n`,
      )
      void this.killCurrentProcess('startup timeout')
      this.url = null
      this.emit('error', message)
    }, ENGINE_READY_TIMEOUT_MS)
    this.readyTimer = { proc, timer: readyTimer }
    const clearReadyTimer = (): void => this.clearReadyTimer(proc)
    const handleChunk = (stream: 'stdout' | 'stderr', data: Buffer): void => {
      writeStderr(data)
      if (this.process === proc) protocol.feed(stream, data)
    }
    proc.stdout?.on('data', (data: Buffer) => handleChunk('stdout', data))
    proc.stderr?.on('data', (data: Buffer) => handleChunk('stderr', data))

    proc.on('exit', (code, signal) => {
      clearReadyTimer()
      // 总是关掉本次 spawn 自己的 stream — 不论是不是当前 active proc
      try {
        writeStderr(
          `\n# === engine exit @ ${new Date().toISOString()} code=${code} signal=${signal} ===\n`,
        )
      } catch {
        /* ignore */
      }

      // 关键防竞态:如果 this.process 已被 restart() 换成新 proc,这次 exit 是
      // 老 proc 的迟到事件,别去清新 proc 的 url/health/etc。早返回即可。
      if (this.process !== proc) {
        this.writeElectronLog(`stale engine exit ignored (replaced) code=${code} signal=${signal}`)
        return
      }

      this.stopHealthCheck()
      const wasReady = this.url !== null
      this.url = null
      this.process = null
      this.writeElectronLog(`engine exit code=${code} signal=${signal} wasReady=${wasReady}`)

      // 1) 应用关闭中(cmd-Q / before-quit) — stop() 发 SIGTERM 后 exit 异步到达,
      //    不该报"崩溃"给 renderer(banner 误闪 + totalCrashes 误增)。
      if (this.stopped) return

      // 2) 已经在重启流程中(handleCrash 通过 health failure 路径主动 SIGTERM)— exit
      //    handler 后到不应再次进 handleCrash 重复 ++restartCount + 重叠 setTimeout。
      //    restartTimer 是"等下次启动"的明确标志。
      if (this.restartTimer !== null) return

      // 退出原因分两种：exit code 非 0(Python 异常退出) 或 signal 非 null(SIGABRT/
      // SIGSEGV/SIGKILL — 比如 PyTorch MPS 并发崩溃就是 code=null signal='SIGABRT')。
      // 之前只看 code !== null 把 signal 退出全漏掉,导致 native 崩溃完全不触发重启。
      const abnormal = (code !== null && code !== 0) || signal !== null
      if (abnormal && wasReady) {
        if (this.restartCount < this.maxRestarts) {
          // 已就绪后崩溃 → 进入重启,UI 显示 "正在重连"
          this.emit('crashed', {
            code,
            signal,
            restartCount: this.restartCount + 1,
            maxRestarts: this.maxRestarts,
          })
        }
        this.handleCrash()
      } else if (abnormal) {
        // 启动期 fail(端口未广播) → 立即报错,UI 显示致命错误
        const reason = signal !== null ? `signal=${signal}` : `exit=${code}`
        this.emit('error', `Engine 启动失败 (${reason})`)
      }
    })

    proc.on('error', (err) => {
      clearReadyTimer()
      closeStderrStream()
      this.writeElectronLog(`engine spawn error: ${err.message}`)
      // ENOENT(binary 不存在) / EACCES 之类 — 'error' 触发后 'exit' 不一定到。
      // 必须主动清状态:否则 this.process 还指向僵死引用,下次 start() 跳过 logsDir
      // 设置等小问题倒不致命,但 stopHealthCheck 必须做(否则 health interval 仍跑)。
      if (this.process === proc) {
        this.process = null
        this.url = null
        this.stopHealthCheck()
      }
      this.emit('error', `Engine spawn 失败: ${err.message}`)
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.lifecycleGeneration += 1
    this.stopHealthCheck()
    this.clearReadyTimer()
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const stopped = this.killCurrentProcess('app shutdown')
    this.url = null
    await Promise.all([stopped, ...this.terminating.values()])
  }

  /** 显式重启 engine — 用户改 settings(key 注入)后调,让新 env var 生效。 */
  private _restartInFlight = false
  async restart(): Promise<void> {
    if (this._restartInFlight || this.stopped) return
    this._restartInFlight = true
    this.lifecycleGeneration += 1
    try {
      this.stopHealthCheck()
      if (this.restartTimer) {
        clearTimeout(this.restartTimer)
        this.restartTimer = null
      }
      this.url = null
      this.emit('crashed', {
        code: null,
        signal: 'RESTART',
        restartCount: 1,
        maxRestarts: this.maxRestarts,
      })
      await this.killCurrentProcess('settings changed, restart')
      if (this.stopped) return
      this.restartCount = 0
      await this.start()
    } finally {
      this._restartInFlight = false
    }
  }

  /**
   * 强杀当前 engine 子进程（如有），释放引用。
   * 关键：在 handleCrash() 重启前必须调用，否则老进程会成为孤儿，
   * 加载着 845MB 模型 + 持续累积 MPS 缓存吃内存（300GB 爆炸的根因之一）。
   *
   * 行为：
   * - 已死（killed/exitCode 已设置）→ 跳过
   * - 否则 SIGTERM；等退出确认，15s 后仍存活才 SIGKILL；调用方可等待清理完成。
   */
  private killCurrentProcess(reason: string): Promise<void> {
    const proc = this.process
    if (!proc) return Promise.resolve()
    this.clearReadyTimer(proc)
    this.process = null // 先解引用，防止 'exit' handler 触发 handleCrash
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()

    const pid = proc.pid
    this.writeElectronLog('kill_engine', 'info', { pgid: pid, reason })
    const pending = terminateEngine(proc, () =>
      this.writeElectronLog('engine_shutdown_timeout_sigkill', 'warn', { pgid: pid }),
    )
    this.terminating.set(proc, pending)
    // Retain unreaped PIDs for the synchronous process-exit fallback.
    proc.once('exit', () => this.terminating.delete(proc))
    proc.once('error', () => this.terminating.delete(proc))
    return pending
  }

  private handleCrash(): void {
    // 已经 stop 了就不再重启，避免应用关闭过程中残留 timer fire 出孤儿
    if (this.stopped) return

    // ⚠ 关键修复：重启前必须先杀老进程。原代码直接 setTimeout(start) 会让
    // this.process 被新 spawn 覆盖，老进程成为孤儿继续吃 RAM。
    const terminated = this.killCurrentProcess('crash/health-failure restart')

    // graceful degrade: 累计崩溃达到 cpuFallbackThreshold 后切 CPU。
    // 0.4.0 已知最常见崩溃源是 PyTorch MPS 多 worker 并发,切 CPU 后绝不再崩。
    // totalCrashCount 永不重置(restartCount 会在 ready 后清 0,不能用)。
    // 一旦切了就不会切回 — 避免反复重启 / 用户继续看到崩溃。
    this.totalCrashCount++
    if (this.speciesDevice === 'auto' && this.totalCrashCount >= this.cpuFallbackThreshold) {
      this.speciesDevice = 'cpu'
      this.writeElectronLog(
        `graceful degrade: switching species inference to CPU (totalCrashes=${this.totalCrashCount})`,
      )
      this.emit('cpu-fallback')
    }

    const delays = [2000, 5000, 10000]
    if (this.restartCount < this.maxRestarts) {
      const delay = delays[this.restartCount] ?? 10000
      const generation = this.lifecycleGeneration
      this.restartCount++
      this.writeElectronLog(
        `restart scheduled in ${delay}ms (attempt ${this.restartCount}/${this.maxRestarts})`,
      )
      // 记录 timer，stop() 能取消；timer 触发时再次检查 stopped 与 generation 防竞态
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        if (this.stopped || generation !== this.lifecycleGeneration) return
        void terminated.then(() => {
          if (!this.stopped && generation === this.lifecycleGeneration) return this.start()
        })
      }, delay)
    } else {
      this.writeElectronLog(`restart limit reached (${this.maxRestarts}), giving up`)
      this.emit('error', 'Python 后端多次崩溃，请检查诊断页面')
    }
  }

  private startHealthCheck(): void {
    let consecutiveFailures = 0
    // 重要：阈值提到 6 次 + 单次 timeout 8s。原 3 次会在 species v3 第一次冷启
    // 推理（~1.5s）撞上时误判为崩溃，触发"假性重启"反复 spawn → 内存爆炸。
    // 6 次失败 = 60s 持续无响应，才是真崩溃。
    const FAIL_THRESHOLD = 6
    const FETCH_TIMEOUT_MS = 8000
    this.healthInterval = setInterval(async () => {
      if (!this.url) return
      const checkedUrl = this.url
      const checkedProcess = this.process
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
      try {
        const response = await fetch(`${checkedUrl}/health`, {
          headers: { Authorization: `Bearer ${this.authToken}` },
          signal: ctrl.signal,
        })
        if (this.url !== checkedUrl || this.process !== checkedProcess) return
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        if (consecutiveFailures > 0) this.emit('ready', checkedUrl)
        consecutiveFailures = 0
      } catch (e) {
        if (this.url !== checkedUrl || this.process !== checkedProcess) return
        consecutiveFailures += 1
        this.healthLog.warn('engine_health_failure', {
          consecutiveFailures,
          threshold: FAIL_THRESHOLD,
          message: (e as Error).message,
        })
        // 连续失败累积时,前端 UI 提前看到"后端无响应",别等 60s 才告知用户
        this.emit('unhealthy', { consecutiveFailures, threshold: FAIL_THRESHOLD })
        if (consecutiveFailures >= FAIL_THRESHOLD) {
          consecutiveFailures = 0
          this.stopHealthCheck()
          this.url = null
          this.writeElectronLog('engine_health_threshold_restart', 'error', {
            threshold: FAIL_THRESHOLD,
          })
          if (this.restartCount < this.maxRestarts) {
            this.emit('crashed', {
              code: null,
              signal: 'HEALTH_FAILURE',
              restartCount: this.restartCount + 1,
              maxRestarts: this.maxRestarts,
            })
          }
          this.handleCrash()
        }
      } finally {
        clearTimeout(timer)
      }
    }, 10000)
  }

  private stopHealthCheck(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval)
      this.healthInterval = null
    }
  }
}
