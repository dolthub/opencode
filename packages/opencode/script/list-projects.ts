#!/usr/bin/env bun
/**
 * Diagnostic script: list all projects in an opencode database file.
 *
 * Usage:
 *   bun script/list-projects.ts <filepath> --sqlite
 *   bun script/list-projects.ts <filepath> --doltlite
 */

import { parseArgs } from "util"

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    sqlite: { type: "boolean", default: false },
    doltlite: { type: "boolean", default: false },
  },
  allowPositionals: true,
})

if (values.sqlite && values.doltlite) {
  console.error(`
Error: --sqlite and --doltlite are mutually exclusive.

Provide exactly one:
  bun script/list-projects.ts <filepath> --sqlite
  bun script/list-projects.ts <filepath> --doltlite
`)
  process.exit(1)
}

if (!values.sqlite && !values.doltlite) {
  console.error(`
Error: you must specify a backend: --sqlite or --doltlite.

Usage:
  bun script/list-projects.ts <filepath> --sqlite     # open with bun:sqlite
  bun script/list-projects.ts <filepath> --doltlite   # open with @dolthub/doltlite
`)
  process.exit(1)
}

if (positionals.length !== 1) {
  console.error(`
Error: expected exactly one positional argument (the database file path).
Got: ${JSON.stringify(positionals)}
`)
  process.exit(1)
}

const filePath = positionals[0]

function run(db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } }) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project'")
    .all() as { name: string }[]

  if (tables.length === 0) {
    console.log("(no 'project' table found — schema may not be applied yet)")
    console.log("\nAll tables present:")
    const all = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    for (const t of all) console.log(" ", t.name)
    return
  }

  const rows = db
    .prepare("SELECT id, worktree, name, time_created FROM project ORDER BY time_created")
    .all() as { id: string; worktree: string; name: string | null; time_created: number }[]

  if (rows.length === 0) {
    console.log("(no projects found)")
    return
  }

  console.log(`Found ${rows.length} project(s):`)
  for (const row of rows) {
    const created = new Date(row.time_created).toISOString()
    const label = row.name ?? "(unnamed)"
    console.log(`  ${row.id}  ${label}  ${row.worktree}  ${created}`)
  }
}

// ── SQLite backend ──────────────────────────────────────────────────────────

if (values.sqlite) {
  const { Database } = await import("bun:sqlite")
  console.log(`Opening with bun:sqlite: ${filePath}\n`)
  const db = new Database(filePath, { readonly: true })
  try {
    run(db as any)
  } finally {
    db.close()
  }
  process.exit(0)
}

// ── DoltLite backend ────────────────────────────────────────────────────────

if (values.doltlite) {
  const { DatabaseSync } = await import("@dolthub/doltlite")
  console.log(`Opening with @dolthub/doltlite: ${filePath}\n`)
  const db = new DatabaseSync(filePath)
  try {
    run(db as any)
  } finally {
    db.close()
  }
  process.exit(0)
}
