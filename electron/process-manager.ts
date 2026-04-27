import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
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
 */
export class ProcessManager extends EventEmitter {
  private process: ChildProcess | null = null
  private url: string | null = null
  private restartCount = 0
  private readonly maxRestarts = 3
  private healthInterval: ReturnType<typeof setInterval> | null = null

  getUrl(): string | null {
    return this.url
  }

  async start(): Promise<void> {
    const isDev = !app.isPackaged

    let command: string
    let args: string[]
    let cwd: string
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PLUMELENS_PORT: '0', // kernel 分配空闲端口
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
      // 用户数据放 ~/Library/Application Support/PlumeLens/（Electron 默认 userData 目录）
      env.PLUMELENS_DATA_DIR = app.getPath('userData')
    }

    // detached: true + 后续按进程组 kill (-pid) → 杀掉整个 engine 子树（含 torch /
    // transformers / pyarrow 内部 spawn 的 helper 进程）。否则 SIGTERM 只杀主进程，
    // helper（如 multiprocessing resource_tracker）会成为孤儿继续吃 RAM。
    this.process = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })

    let pendingUrl: string | null = null
    const handleChunk = (data: Buffer): void => {
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
        this.emit('ready', this.url)
        this.startHealthCheck()
        return
      }
      // Fallback：uvicorn 老 banner（同时兼具 listen 完成的语义）
      const uvicornMatch = text.match(/Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/)
      if (uvicornMatch && !this.url) {
        this.url = uvicornMatch[1]
        this.emit('ready', this.url)
        this.startHealthCheck()
      }
    }

    this.process.stdout?.on('data', handleChunk)
    this.process.stderr?.on('data', handleChunk)

    this.process.on('exit', (code) => {
      this.stopHealthCheck()
      const wasReady = this.url !== null
      this.url = null
      if (code !== 0 && code !== null && wasReady) {
        // 已就绪后崩溃 → 进入重启
        this.handleCrash()
      } else if (code !== 0 && code !== null) {
        // 启动期 fail（端口未广播） → 立即报错
        this.emit('error', `Engine 启动失败 (exit=${code})`)
      }
    })

    this.process.on('error', (err) => {
      this.emit('error', `Engine spawn 失败: ${err.message}`)
    })
  }

  stop(): void {
    this.stopHealthCheck()
    this.killCurrentProcess('app shutdown')
    this.url = null
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
    process.stderr.write(`[engine-pm] kill engine pgid=${pid} reason=${reason}\n`)
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
        process.stderr.write(
          `[engine-pm] engine pgid=${pid} did not exit in 3s, SIGKILL\n`,
        )
        try {
          if (pid !== undefined) process.kill(-pid, 'SIGKILL')
        } catch {
          try { proc.kill('SIGKILL') } catch { /* ignore */ }
        }
      }
    }, 3000)
  }

  private handleCrash(): void {
    // ⚠ 关键修复：重启前必须先杀老进程。原代码直接 setTimeout(start) 会让
    // this.process 被新 spawn 覆盖，老进程成为孤儿继续吃 RAM。
    this.killCurrentProcess('crash/health-failure restart')

    const delays = [2000, 5000, 10000]
    if (this.restartCount < this.maxRestarts) {
      const delay = delays[this.restartCount] ?? 10000
      this.restartCount++
      setTimeout(() => this.start(), delay)
    } else {
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
        const response = await fetch(`${this.url}/health`, { signal: ctrl.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        consecutiveFailures = 0
      } catch (e) {
        consecutiveFailures += 1
        process.stderr.write(
          `[engine-health] failure ${consecutiveFailures}/${FAIL_THRESHOLD}: ${(e as Error).message}\n`,
        )
        if (consecutiveFailures >= FAIL_THRESHOLD) {
          consecutiveFailures = 0
          this.stopHealthCheck()
          this.url = null
          this.emit(
            'error',
            `Engine 连续 ${FAIL_THRESHOLD} 次健康检查失败，触发重启`,
          )
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
