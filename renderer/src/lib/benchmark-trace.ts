export type BenchmarkApiArea =
  | 'library-list'
  | 'library-detail'
  | 'selection-query'
  | 'health'
  | 'photo-review'

export interface BenchmarkTraceEvent {
  name: string
  at: number
  id?: number
  area?: BenchmarkApiArea
  status?: number
}

const MAX_TRACE_EVENTS = 4096

function initializeEvents(): BenchmarkTraceEvent[] | undefined {
  if (typeof window === 'undefined') return undefined
  const existing = window.__PLUMELENS_BENCHMARK_TRACE__
  if (Array.isArray(existing)) return existing
  if (!window.plumelens?.benchmarkTraceEnabled) return undefined
  return (window.__PLUMELENS_BENCHMARK_TRACE__ = [])
}

function createTrace(events: BenchmarkTraceEvent[]) {
  let id = 0
  const references = new WeakMap<object, number>()

  function mark(name: string, fields: Partial<Omit<BenchmarkTraceEvent, 'name'>> = {}): void {
    if (events.length >= MAX_TRACE_EVENTS) return
    events.push({ name, at: fields.at ?? performance.now(), ...fields })
  }

  return {
    mark,
    start(name: string, area?: BenchmarkApiArea): number {
      id += 1
      mark(name, { id, ...(area && { area }) })
      return id
    },
    markFor(name: string, reference: object): void {
      const existingId = references.get(reference)
      if (existingId !== undefined) {
        mark(name, { id: existingId })
      } else {
        id += 1
        references.set(reference, id)
        mark(name, { id })
      }
    },
  }
}

const events = initializeEvents()
export const benchmarkTrace = events ? createTrace(events) : undefined
