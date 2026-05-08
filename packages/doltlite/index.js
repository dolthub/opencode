"use strict"

const path = require("path")

// Try prebuilt binary first (downloaded from npm tarball at install time),
// then fall back to a locally compiled build.
function loadAddon() {
  const platform = process.platform
  const arch = process.arch
  const prebuilt = path.join(__dirname, "prebuilds", `${platform}-${arch}`, "doltlite.node")
  const compiled = path.join(__dirname, "build", "Release", "doltlite.node")

  for (const candidate of [prebuilt, compiled]) {
    try {
      return require(candidate)
    } catch (_) {
      // try next candidate
    }
  }

  throw new Error(
    `@dolthub/doltlite: no native binary found for ${platform}-${arch}.\n` +
    `Run \`bun install\` to fetch a prebuilt, or file an issue at ` +
    `https://github.com/dolthub/doltlite-node/issues`
  )
}

const { DatabaseSync, StatementSync } = loadAddon()
module.exports = { DatabaseSync, StatementSync }
