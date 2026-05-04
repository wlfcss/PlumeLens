import { ChildProcess, spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'fs'
import { app } from 'electron'
import { join } from 'path'

/**
 * 拉起并守护 Python engine 子进程。
 *
 * Dev：`uv run uvicorn engine.main:app --port 0`（uvicorn 直接打 stderr）
 * Prod：PyInstaller frozen binary `plumelens-engine`（自己 stdout 打印 `PLUMELENS_PORT <n>`）
 *
 * 端口握手协议：engine 启动后会打印 `PLUMELENS_PORT <n>`（stdout），收到即可知道
 * 实际监听端口；不依赖 uvicorn 的 banner 文本（更稳定，frozen 下 uvicorn 输出格式可能变）。
 *
 * 日志持久化：
 * - engine 子进程 stderr → logs/engine.stderr.{startup_ts}.log（每次启动新文件，
 *   保留最近 MAX_STARTUP_LOGS 个，旧的自动删）。这是 PyInstaller / uvicorn /
 *   segfault 等 raw 输出唯一落点，崩溃时关键。
 * - process-manager 自身事件 → logs/electron.log（append，简单 5MB 截断）。
 * - 后端 structlog 事件单独走 logs/engine.jsonl（由 engine.core.logging 配置）。
 */

const MAX_STARTUP_LOGS = 10
const ELECTRON_LOG_MAX_BYTES = 5 * 1024 * 1024

export class ProcessManager extends EventEmitter {
  private process: ChildProcess | null = null
  private url: string | null = null
  private restartCount = 0
  private readonly maxRestarts = 3
  private healthInterval: ReturnType<typeof setInterval> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private readonly authToken = randomBytes(32).toString('hex')
  // 关停标志：stop() 设为 true，handleCrash 与 setTimeout 都会检查，
  // 防止应用关闭中残留的 setTimeout 触发 spawn 出孤儿 engine。
  private stopped = false
  // 当前启动的 engine stderr 落盘流；spawn 时新建，子进程 exit 时关闭
  private engineStderrStream: WriteStream | null = null
  // 持久化日志根目录（{userData}/logs），lazy 创建
  private readonly logsDir = join(app.getPath('userData'), 'logs')

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

  getUrl(): string | null {
    return this.url
  }

  getAuthToken(): string {
    return this.authToken
  }

  /** 确保 logs/ 目录存在；返回 true 表示可以写文件日志。失败不阻断启动。 */
  private ensureLogsDir(): boolean {
    try {
      if (!existsSync(this.logsDir)) mkdirSync(this.logsDir, { recursive: true })
      return true
    } catch (err) {
      process.stderr.write(`[engine-pm] cannot create logs dir: ${(err as Error).message}\n`)
      return false
    }
  }

  /** 简单 append 一行到 electron.log；超过 5MB 自动截断成 .log.old + 新建。 */
  private writeElectronLog(message: string): void {
    if (!this.ensureLogsDir()) return
    const logPath = join(this.logsDir, 'electron.log')
    try {
      if (existsSync(logPath) && statSync(logPath).size > ELECTRON_LOG_MAX_BYTES) {
        const archive = `${logPath}.old`
        try { unlinkSync(archive) } catch { /* ignore: file may not exist */ }
        try { renameSync(logPath, archive) } catch { /* ignore */ }
      }
      const ts = new Date().toISOString()
      appendFileSync(logPath, `${ts} ${message}\n`, 'utf-8')
    } catch (err) {
      process.stderr.write(`[engine-pm] electron.log write failed: ${(err as Error).message}\n`)
    }
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
        try { unlinkSync(join(this.logsDir, old.name)) } catch { /* ignore */ }
      }
    } catch {
      /* ignore */
    }
  }

  /** 为本次 spawn 新建 engine.stderr.{startup_ts}.log 写入流。
   *
   * timestamp 保留毫秒精度（20260429T120000123Z），避免 1 秒内连续两次 spawn
   * （崩溃重启 / 快速 dev 循环）撞同名 → createWriteStream 走 append flag 把两次
   * 启动日志混到一个文件里。 */
  private openStderrLog(): WriteStream | null {
    if (!this.ensureLogsDir()) return null
    const ts = new Date().toISOString().replace(/[-:.]/g, '')
    const path = join(this.logsDir, `engine.stderr.${ts}.log`)
    try {
      const stream = createWriteStream(path, { flags: 'a', encoding: 'utf-8' })
      stream.write(`# === engine spawn @ ${new Date().toISOString()} ===\n`)
      return stream
    } catch (err) {
      process.stderr.write(`[engine-pm] cannot open stderr log: ${(err as Error).message}\n`)
      return null
    }
  }

  async start(): Promise<void> {
    const isDev = !app.isPackaged

    // 持久化日志：本次 spawn 一个新 engine.stderr.log（保留最近 10 个）
    this.pruneOldStderrLogs()
    this.engineStderrStream = this.openStderrLog()

    let command: string
    let args: string[]
    let cwd: string
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PLUMELENS_PORT: '0', // kernel 分配空闲端口
      // 让 engine 的数据库/缩略图目录和主进程 plumelens://thumb 协议读的目录一致。
      // 之前 dev 模式 engine 默认写 ~/.plumelens，而 Electron 协议读 userData，
      // DB 里有 thumb 路径但文件在另一个根目录，选片页就会频繁显示空缩略图。
      PLUMELENS_DATA_DIR: app.getPath('userData'),
      PLUMELENS_API_TOKEN: this.authToken,
    }

    // graceful degrade: 已经决定切 CPU 后,后续每次 spawn 都强制传这个 env。
    // engine 的 Settings.species_provider 会从 PLUMELENS_SPECIES_PROVIDER 读。
    if (this.speciesDevice === 'cpu') {
      env.PLUMELENS_SPECIES_PROVIDER = 'cpu'
    }

    // 用户自带的 reverse geocoding API keys — 从 userData/settings.json 读,注入 env
    // 给后端 geocoder chain 使用(amap → baidu → tencent → nominatim → offline)。
    // v1 用户在 Finder 编辑 ~/Library/Application Support/plumelens/settings.json 加:
    //   {"amapKey": "xxx", "baiduAk": "yyy", "tencentKey": "zzz"}
    // v2 加 settings UI 让用户填表。失败/不存在静默忽略,不影响启动。
    try {
      const settingsPath = join(app.getPath('userData'), 'settings.json')
      if (existsSync(settingsPath)) {
        const userSettings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
          amapKey?: string
          baiduAk?: string
          tencentKey?: string
        }
        if (userSettings.amapKey) env.PLUMELENS_AMAP_KEY = userSettings.amapKey
        if (userSettings.baiduAk) env.PLUMELENS_BAIDU_AK = userSettings.baiduAk
        if (userSettings.tencentKey) env.PLUMELENS_TENCENT_KEY = userSettings.tencentKey
      }
    } catch (err) {
      this.writeElectronLog(`failed to read user settings.json: ${(err as Error).message}`)
    }

    if (isDev) {
      command = 'uv'
      args = ['run', 'python', '-m', 'engine']
      cwd = join(__dirname, '../../')
    } else {
      // PyInstaller frozen binary: Resources/plumelens-engine/plumelens-engine
      command = join(process.resourcesPath, 'plumelens-engine', 'plumelens-engine')
      args = []
      cwd = join(process.resourcesPath, 'plumelens-engine')
      // Production：模型文件由 electron-builder extraResources 放在 Resources/models/
      env.PLUMELENS_MODELS_DIR = join(process.resourcesPath, 'models')
      // Strict 模式：缺 IQA 模型直接启动失败，不允许伪造 0.5 中性分。
      // 不在这里设 dev 也跑不起来（开发期还没下载所有模型时方便迭代）。
      env.PLUMELENS_REQUIRE_IQA = '1'
    }

    // detached: true + 后续按进程组 kill (-pid) → 杀掉整个 engine 子树（含 torch /
    // transformers / pyarrow 内部 spawn 的 helper 进程）。否则 SIGTERM 只杀主进程，
    // helper（如 multiprocessing resource_tracker）会成为孤儿继续吃 RAM。
    this.writeElectronLog(`spawn engine: cmd=${command} cwd=${cwd} dev=${isDev}`)
    this.process = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })

    let pendingUrl: string | null = null
    const handleChunk = (data: Buffer): void => {
      // 1. 完整复制到持久化文件（崩溃时唯一可查的 raw stderr / stdout）
      this.engineStderrStream?.write(data)
      // 2. 解析 PORT/READY 协议
      const text = data.toString()
      // PLUMELENS_PORT N（uvicorn.run 之前 print）：先记下 URL，但还没 listen
      const portMatch = text.match(/PLUMELENS_PORT (\d+)/)
      if (portMatch && !pendingUrl) {
        pendingUrl = `http://127.0.0.1:${portMatch[1]}`
      }
      // PLUMELENS_READY（lifespan startup 完成、uvicorn 真 listen 后 print）：才 emit ready
      // 避免 IPC 早一步返回 URL → renderer 立即 fetch → ECONNREFUSED 失败
      if (text.includes('PLUMELENS_READY') && pendingUrl && !this.url) {
        this.url = pendingUrl
        // 启动成功 → 重置 restartCount。否则应用长时间运行后才崩溃，
        // restartCount 已经爆 maxRestarts，不会再重启（恢复能力降为 0）。
        this.restartCount = 0
        this.writeElectronLog(`engine ready url=${this.url}`)
        this.emit('ready', this.url)
        this.startHealthCheck()
        return
      }
      // Fallback：uvicorn 老 banner（同时兼具 listen 完成的语义）
      const uvicornMatch = text.match(/Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/)
      if (uvicornMatch && !this.url) {
        this.url = uvicornMatch[1]
        this.restartCount = 0
        this.writeElectronLog(`engine ready (uvicorn fallback) url=${this.url}`)
        this.emit('ready', this.url)
        this.startHealthCheck()
      }
    }

    this.process.stdout?.on('data', handleChunk)
    this.process.stderr?.on('data', handleChunk)

    this.process.on('exit', (code, signal) => {
      this.stopHealthCheck()
      const wasReady = this.url !== null
      this.url = null
      // 关闭本次 spawn 的 stderr 流；下次 start() 会新开
      try {
        this.engineStderrStream?.write(
          `\n# === engine exit @ ${new Date().toISOString()} code=${code} signal=${signal} wasReady=${wasReady} ===\n`,
        )
        this.engineStderrStream?.end()
      } catch { /* ignore */ }
      this.engineStderrStream = null
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
        // 已就绪后崩溃 → 进入重启,UI 显示 "正在重连"
        this.emit('crashed', { code, signal, restartCount: this.restartCount + 1, maxRestarts: this.maxRestarts })
        this.handleCrash()
      } else if (abnormal) {
        // 启动期 fail(端口未广播) → 立即报错,UI 显示致命错误
        const reason = signal !== null ? `signal=${signal}` : `exit=${code}`
        this.emit('error', `Engine 启动失败 (${reason})`)
      }
    })

    this.process.on('error', (err) => {
      this.writeElectronLog(`engine spawn error: ${err.message}`)
      this.emit('error', `Engine spawn 失败: ${err.message}`)
    })
  }

  stop(): void {
    this.stopped = true
    this.stopHealthCheck()
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.killCurrentProcess('app shutdown')
    this.url = null
  }

  /** 显式重启 engine — 用户改 settings(key 注入)后调,让新 env var 生效。
   * 与 stop() 不同:复位 stopped flag,清掉老 url,然后 spawn 新进程。 */
  async restart(): Promise<void> {
    this.stopHealthCheck()
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.killCurrentProcess('settings changed, restart')
    this.url = null
    this.stopped = false
    this.restartCount = 0
    await this.start()
  }

  /**
   * 强杀当前 engine 子进程（如有），释放引用。
   * 关键：在 handleCrash() 重启前必须调用，否则老进程会成为孤儿，
   * 加载着 845MB 模型 + 持续累积 MPS 缓存吃内存（300GB 爆炸的根因之一）。
   *
   * 行为：
   * - 已死（killed/exitCode 已设置）→ 跳过
   * - 否则 SIGTERM；3s 后还活着 → SIGKILL（比之前的 5s 短，避免重启拖延）
   */
  private killCurrentProcess(reason: string): void {
    const proc = this.process
    if (!proc) return
    this.process = null  // 先解引用，防止 'exit' handler 触发 handleCrash
    if (proc.killed || proc.exitCode !== null) return

    const pid = proc.pid
    const killMsg = `kill engine pgid=${pid} reason=${reason}`
    process.stderr.write(`[engine-pm] ${killMsg}\n`)
    this.writeElectronLog(killMsg)
    // 关键：kill 进程组而不是单一 PID（pid + detached:true → engine 是 process group leader）
    // 负数 PID 给 process.kill 表示"信号发到整个进程组"，一举杀掉 helper / spawned children。
    try {
      if (pid !== undefined) process.kill(-pid, 'SIGTERM')
    } catch {
      // 兜底：直接信号主 PID
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
    }
    setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) {
        const sigkillMsg = `engine pgid=${pid} did not exit in 3s, SIGKILL`
        process.stderr.write(`[engine-pm] ${sigkillMsg}\n`)
        this.writeElectronLog(sigkillMsg)
        try {
          if (pid !== undefined) process.kill(-pid, 'SIGKILL')
        } catch {
          try { proc.kill('SIGKILL') } catch { /* ignore */ }
        }
      }
    }, 3000)
  }

  private handleCrash(): void {
    // 已经 stop 了就不再重启，避免应用关闭过程中残留 timer fire 出孤儿
    if (this.stopped) return

    // ⚠ 关键修复：重启前必须先杀老进程。原代码直接 setTimeout(start) 会让
    // this.process 被新 spawn 覆盖，老进程成为孤儿继续吃 RAM。
    this.killCurrentProcess('crash/health-failure restart')

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
      this.restartCount++
      this.writeElectronLog(`restart scheduled in ${delay}ms (attempt ${this.restartCount}/${this.maxRestarts})`)
      // 记录 timer，stop() 能取消；timer 触发时再次检查 stopped 防竞态
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        if (this.stopped) return
        void this.start()
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
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
      try {
        const response = await fetch(`${this.url}/health`, {
          headers: { Authorization: `Bearer ${this.authToken}` },
          signal: ctrl.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        consecutiveFailures = 0
      } catch (e) {
        consecutiveFailures += 1
        const failMsg = `health failure ${consecutiveFailures}/${FAIL_THRESHOLD}: ${(e as Error).message}`
        process.stderr.write(`[engine-health] ${failMsg}\n`)
        this.writeElectronLog(failMsg)
        // 连续失败累积时,前端 UI 提前看到"后端无响应",别等 60s 才告知用户
        this.emit('unhealthy', { consecutiveFailures, threshold: FAIL_THRESHOLD })
        if (consecutiveFailures >= FAIL_THRESHOLD) {
          consecutiveFailures = 0
          this.stopHealthCheck()
          this.url = null
          this.writeElectronLog(`engine connected ${FAIL_THRESHOLD} health failures, triggering restart`)
          this.emit('crashed', {
            code: null,
            signal: 'HEALTH_FAILURE',
            restartCount: this.restartCount + 1,
            maxRestarts: this.maxRestarts,
          })
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
