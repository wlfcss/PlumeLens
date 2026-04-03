import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { app } from 'electron'
import { join } from 'path'

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

    if (isDev) {
      command = 'uv'
      args = ['run', 'uvicorn', 'engine.main:app', '--host', '127.0.0.1', '--port', '0']
      cwd = join(__dirname, '../../')
    } else {
      // TODO: packaged mode — use PyInstaller binary
      command = join(process.resourcesPath, 'engine', 'plumelens-engine')
      args = []
      cwd = process.resourcesPath
    }

    this.process = spawn(command, args, {
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      // uvicorn prints: "Uvicorn running on http://127.0.0.1:XXXXX"
      const match = text.match(/Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) {
        this.url = match[1]
        this.emit('ready', this.url)
        this.startHealthCheck()
      }
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      // uvicorn also logs to stderr
      const match = text.match(/Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) {
        this.url = match[1]
        this.emit('ready', this.url)
        this.startHealthCheck()
      }
    })

    this.process.on('exit', (code) => {
      this.stopHealthCheck()
      if (code !== 0 && code !== null) {
        this.handleCrash()
      }
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
    this.healthInterval = setInterval(async () => {
      if (!this.url) return
      try {
        const response = await fetch(`${this.url}/health`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
      } catch {
        // Health check failed — backend may have crashed
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
