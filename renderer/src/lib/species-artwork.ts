export function speciesArtworkAssetUrl(canonicalSci: string | null | undefined): string | null {
  if (!canonicalSci?.trim()) return null
  return `plumelens://species-artwork/${encodeURIComponent(canonicalSci.trim())}`
}
