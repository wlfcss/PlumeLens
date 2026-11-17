import { StringDecoder } from 'node:string_decoder'

/** stdout/stderr chunks are arbitrary byte boundaries, not protocol messages. */
export class EngineStartupProtocol {
  private readonly decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  }
  private readonly buffers = { stdout: '', stderr: '' }
  private port: number | null = null
  private ready = false
  private emitted = false

  constructor(private readonly onReady: (url: string) => void) {}

  feed(stream: 'stdout' | 'stderr', data: Buffer): void {
    const text = this.buffers[stream] + this.decoders[stream].write(data)
    const lines = text.split('\n')
    this.buffers[stream] = (lines.pop() ?? '').slice(-65_536)
    for (const raw of lines) {
      const line = raw.trim()
      const port = /^PLUMELENS_PORT (\d+)$/.exec(line)
      if (port) {
        const value = Number(port[1])
        if (value > 0 && value <= 65_535) this.port = value
      }
      if (line === 'PLUMELENS_READY') this.ready = true
      const fallback = /Uvicorn running on http:\/\/127\.0\.0\.1:(\d+)/.exec(line)
      if (fallback) {
        const value = Number(fallback[1])
        if (value > 0 && value <= 65_535) {
          this.port = value
          this.ready = true
        }
      }
      if (this.ready && this.port && !this.emitted) {
        this.emitted = true
        this.onReady(`http://127.0.0.1:${this.port}`)
      }
    }
  }
}
