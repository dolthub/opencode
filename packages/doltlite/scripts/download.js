#!/usr/bin/env node
// Downloads prebuilt doltlite native binaries from the @dolthub/doltlite npm
// package tarball (which bundles prebuilts for all supported platforms).
//
// On macOS, both x64 and arm64 are fetched so the package works under both
// Node (x64) and Bun (arm64) regardless of which runs the install script.
// On other platforms, only the current arch is fetched.
//
// Run as the package install script; exits 0 if at least one prebuilt was
// placed, exits 1 to trigger the node-gyp fallback in the install command.

"use strict"

const https = require("https")
const zlib  = require("zlib")
const fs    = require("fs")
const path  = require("path")

const pkg      = require("../package.json")
const version  = pkg.version
const platform = process.platform
const arches   = platform === "darwin" ? ["x64", "arm64"] : [process.arch]

const tarballUrl = `https://registry.npmjs.org/@dolthub/doltlite/-/doltlite-${version}.tgz`

// Skip if all prebuilts already present.
const needed = arches.filter(
  (a) => !fs.existsSync(path.join(__dirname, "../prebuilds", `${platform}-${a}`, "doltlite.node"))
)
if (needed.length === 0) process.exit(0)

console.log(`doltlite: downloading prebuilt v${version} for ${platform} [${needed.join(", ")}]...`)

// Download the npm tarball into memory, then scan the tar headers to extract
// the entries we need.  The tarball is ~14 MB so buffering is fine.
function downloadBuffer(url, cb) {
  function get(u) {
    https.get(u, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location)
      if (res.statusCode !== 200) return cb(new Error(`HTTP ${res.statusCode} from ${u}`))
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => cb(null, Buffer.concat(chunks)))
      res.on("error", cb)
    }).on("error", cb)
  }
  get(url)
}

function gunzip(buf, cb) {
  zlib.gunzip(buf, cb)
}

// Extract specific entries from an in-memory tar buffer.
// Returns a Map<entryPath, Buffer>.
function extractEntries(tarBuf, targets) {
  const BLOCK = 512
  const result = new Map()
  let pos = 0

  while (pos + BLOCK <= tarBuf.length) {
    const hdr = tarBuf.slice(pos, pos + BLOCK)
    if (hdr.every((b) => b === 0)) break

    const name    = hdr.slice(0, 100).toString("utf8").replace(/\0.*/g, "")
    const sizeStr = hdr.slice(124, 136).toString("utf8").replace(/\0.*/g, "").trim()
    const size    = parseInt(sizeStr, 8) || 0
    const dataStart = pos + BLOCK

    if (targets.has(name)) {
      result.set(name, tarBuf.slice(dataStart, dataStart + size))
    }

    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }

  return result
}

downloadBuffer(tarballUrl, (err, compressedBuf) => {
  if (err) {
    console.warn(`doltlite: download failed (${err.message}); will fall back to compilation.`)
    process.exit(1)
  }

  gunzip(compressedBuf, (err, tarBuf) => {
    if (err) {
      console.warn(`doltlite: gunzip failed (${err.message}); will fall back to compilation.`)
      process.exit(1)
    }

    const targets = new Map(
      needed.map((a) => [
        `package/prebuilds/${platform}-${a}/doltlite.node`,
        path.join(__dirname, "../prebuilds", `${platform}-${a}`, "doltlite.node"),
      ])
    )

    const extracted = extractEntries(tarBuf, new Set(targets.keys()))

    let wrote = 0
    for (const [entryPath, destFile] of targets) {
      const data = extracted.get(entryPath)
      if (!data) {
        console.warn(`doltlite: prebuilt not found in tarball: ${entryPath}`)
        continue
      }
      fs.mkdirSync(path.dirname(destFile), { recursive: true })
      fs.writeFileSync(destFile, data)
      wrote++
    }

    if (wrote === 0) {
      console.warn(`doltlite: no prebuilts extracted; will fall back to compilation.`)
      process.exit(1)
    }

    console.log(`doltlite: ${wrote} prebuilt(s) ready.`)
  })
})
