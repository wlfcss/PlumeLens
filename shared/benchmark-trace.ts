export const BENCHMARK_TRACE_ARGUMENT = '--plumelens-benchmark-trace'

/** Relative to the preload document's performance time origin. Contains only timing data. */
export interface EngineBenchmarkTiming {
  timeOrigin: number
  fetchStart: number
  headers: number
  body: number
}
