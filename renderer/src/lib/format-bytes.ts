/** 字节数 → 人读字符串(KB / MB / GB)。RAW 文件常 30-100 MB,误差 ±0.1 可接受。 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '--'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
