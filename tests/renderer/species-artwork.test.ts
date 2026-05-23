import { describe, expect, it } from 'vitest'

import { speciesArtworkAssetUrl } from '@/lib/species-artwork'

describe('speciesArtworkAssetUrl', () => {
  it('routes a canonical species name to a local plumelens packaged asset key', () => {
    const url = speciesArtworkAssetUrl('Ardeola bacchus')

    expect(url).toBe('plumelens://species-artwork/Ardeola%20bacchus')
    expect(url).not.toContain('upload.wikimedia.org')
  })

  it('does not require the original remote image URL at runtime', () => {
    expect(speciesArtworkAssetUrl(null)).toBeNull()
    expect(speciesArtworkAssetUrl('')).toBeNull()
    expect(speciesArtworkAssetUrl('   ')).toBeNull()
  })
})
