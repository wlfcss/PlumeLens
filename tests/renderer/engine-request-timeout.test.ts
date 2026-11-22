import { describe, expect, it } from 'vitest'
import { engineRequestTimeout } from '../../shared/engine-request-timeout'

describe('engine request timeout', () => {
  it('allows time to verify a relocated library, including when a query string is present', () => {
    expect(engineRequestTimeout('/library/gallery-id/relink?refresh=1')).toBe(30 * 60_000)
  })

  it('keeps the normal timeout for a library detail request', () => {
    expect(engineRequestTimeout('/library/gallery-id')).toBe(60_000)
  })
})
