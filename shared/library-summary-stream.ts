export const LIBRARY_SUMMARY_BATCH_MEDIA_TYPE = 'application/x-ndjson'

/** Decode complete UTF-8 records regardless of transport chunk boundaries. */
export async function readSummaryLines(
  body: ReadableStream<Uint8Array>,
  receive: (line: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const text = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      let decoded = text.decode(value, { stream: true })
      let newline = decoded.indexOf('\n')
      while (newline !== -1) {
        receive(pending + decoded.slice(0, newline))
        pending = ''
        decoded = decoded.slice(newline + 1)
        newline = decoded.indexOf('\n')
      }
      pending += decoded
    }
    if (pending + text.decode()) throw new Error('Incomplete library summary record')
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}
