#!/usr/bin/env node
/**
 * 一次性下载阿里 dataV 中国省级 + 市级 GeoJSON 到 renderer/src/data/geojson/。
 *
 * - china.json:全国 35 个省/直辖市/特区(已下载)
 * - {adcode}.json: 每个省的省级文件,包含该省所有市的边界(用于二级钻取)
 *
 * dataV API: https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json
 *
 * 总体积 ~5 MB(31 省 × 平均 150KB)。一次下载,进 git;后续地图升级时手动更新。
 */
const fs = require('fs')
const path = require('path')
const https = require('https')

const OUT_DIR = path.join(__dirname, '..', 'renderer', 'src', 'data', 'geojson')
const CHINA_PATH = path.join(OUT_DIR, 'china.json')

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`))
          return
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(Buffer.concat(chunks).toString('utf-8'))
          } catch (e) {
            reject(e)
          }
        })
        res.on('error', reject)
      })
      .on('error', reject)
  })
}

async function main() {
  if (!fs.existsSync(CHINA_PATH)) {
    console.error(`china.json not found at ${CHINA_PATH}, run curl first`)
    process.exit(1)
  }
  const china = JSON.parse(fs.readFileSync(CHINA_PATH, 'utf-8'))
  const provinces = china.features.map((f) => ({
    adcode: String(f.properties.adcode),
    name: f.properties.name,
  }))
  console.log(`Found ${provinces.length} provinces. Downloading per-province GeoJSON...`)

  // 串行下载,避免触发对方 rate limit
  for (const { adcode, name } of provinces) {
    const out = path.join(OUT_DIR, `${adcode}.json`)
    if (fs.existsSync(out)) {
      console.log(`  ✓ ${adcode} ${name} (cached)`)
      continue
    }
    const url = `https://geo.datav.aliyun.com/areas_v3/bound/${adcode}_full.json`
    try {
      const text = await fetchJSON(url)
      fs.writeFileSync(out, text, 'utf-8')
      console.log(`  ✓ ${adcode} ${name} (${(text.length / 1024).toFixed(0)} KB)`)
    } catch (err) {
      console.warn(`  ✗ ${adcode} ${name}: ${err.message}`)
    }
    // 小延迟,做个守规矩的客户端
    await new Promise((r) => setTimeout(r, 100))
  }

  // 汇总
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.json'))
  let total = 0
  for (const f of files) total += fs.statSync(path.join(OUT_DIR, f)).size
  console.log(`\nTotal: ${files.length} files, ${(total / 1024 / 1024).toFixed(2)} MB`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
