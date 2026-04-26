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

    this.process = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
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
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM')
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL')
        }
      }, 5000)
    }
    this.process = null
    this.url = null
  }

  private handleCrash(): void {
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
    this.healthInterval = setInterval(async () => {
      if (!this.url) return
      try {
        const response = await fetch(`${this.url}/health`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        consecutiveFailures = 0
      } catch (e) {
        consecutiveFailures += 1
        process.stderr.write(
          `[engine-health] failure ${consecutiveFailures}: ${(e as Error).message}\n`,
        )
        // 连续 3 次失败（30 秒）视为崩溃，触发重启
        if (consecutiveFailures >= 3) {
          consecutiveFailures = 0
          this.stopHealthCheck()
          this.url = null
          this.emit('error', `Engine 连续 3 次健康检查失败，触发重启`)
          this.handleCrash()
        }
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
