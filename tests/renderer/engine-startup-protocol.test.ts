import { describe, expect, it } from 'vitest'
import { EngineStartupProtocol } from '../../electron/engine-startup-protocol'

describe('engine startup byte stream', () => {
  it('recognizes every split position including a multibyte log and two protocol lines', () => {
    const message = Buffer.from('模型加载中\nPLUMELENS_PORT 12345\nPLUMELENS_READY\n')
    for (let split = 1; split < message.length; split++) {
      const urls: string[] = []
      const protocol = new EngineStartupProtocol((url) => urls.push(url))
      protocol.feed('stdout', message.subarray(0, split))
      protocol.feed('stdout', message.subarray(split))
      expect(urls).toEqual(['http://127.0.0.1:12345'])
    }
  })
  it('handles interleaved streams and READY arriving before PORT exactly once', () => {
    const urls: string[] = []
    const protocol = new EngineStartupProtocol((url) => urls.push(url))
    protocol.feed('stderr', Buffer.from('PLUMELENS_RE'))
    protocol.feed('stdout', Buffer.from('PLUMELENS_PO'))
    protocol.feed('stderr', Buffer.from('ADY\n'))
    expect(urls).toEqual([])
    protocol.feed('stdout', Buffer.from('RT 23456\nPLUMELENS_READY\n'))
    expect(urls).toEqual(['http://127.0.0.1:23456'])
  })
  it('ignores logged token fragments and invalid ports, supports a chunked legacy banner', () => {
    const urls: string[] = []
    const protocol = new EngineStartupProtocol((url) => urls.push(url))
    protocol.feed('stdout', Buffer.from('debug PLUMELENS_READY\nPLUMELENS_PORT 99999\n'))
    protocol.feed('stderr', Buffer.from('INFO: Uvicorn running on http://127.0.'))
    expect(urls).toEqual([])
    protocol.feed('stderr', Buffer.from('0.1:34567 (Press CTRL+C to quit)\n'))
    expect(urls).toEqual(['http://127.0.0.1:34567'])
  })
})
