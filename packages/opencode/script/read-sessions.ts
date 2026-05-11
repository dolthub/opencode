#!/usr/bin/env bun
/**
 * Diagnostic script: read session IDs from an opencode database file.
 *
 * Usage:
 *   bun script/read-sessions.ts <filepath> --sqlite
 *   bun script/read-sessions.ts <filepath> --doltlite
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

// Validate exactly one backend flag
if (values.sqlite && values.doltlite) {
  console.error(`
Error: --sqlite and --doltlite are mutually exclusive.

Provide exactly one:
  bun script/read-sessions.ts <filepath> --sqlite
  bun script/read-sessions.ts <filepath> --doltlite
`)
  process.exit(1)
}

if (!values.sqlite && !values.doltlite) {
  console.error(`
Error: you must specify a backend: --sqlite or --doltlite.

Usage:
  bun script/read-sessions.ts <filepath> --sqlite     # open with bun:sqlite
  bun script/read-sessions.ts <filepath> --doltlite   # open with @dolthub/doltlite
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

type Row = { id: string; title: string; project_id: string; project_worktree: string; project_name: string | null }

function run(db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[]; run: (...args: unknown[]) => unknown } }) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session'")
    .all() as { name: string }[]

  if (tables.length === 0) {
    console.log("(no 'session' table found — schema may not be applied yet)")
    console.log("\nAll tables present:")
    const all = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    for (const t of all) console.log(" ", t.name)
    return
  }

  const rows = db.prepare(`
    SELECT s.id, s.title, s.project_id,
           p.worktree AS project_worktree, p.name AS project_name
    FROM session s
    LEFT JOIN project p ON p.id = s.project_id
    ORDER BY s.time_created
  `).all() as Row[]

  if (rows.length === 0) {
    console.log("(no sessions found)")
    return
  }

  console.log(`Found ${rows.length} session(s):`)
  for (const row of rows) {
    const proj = row.project_name ? `${row.project_name} (${row.project_id})` : `${row.project_id}`
    console.log(`  ${row.id}  "${row.title}"  project=${proj}  worktree=${row.project_worktree}`)
  }
}

// ── SQLite backend ──────────────────────────────────────────────────────────

if (values.sqlite) {
  const { Database } = await import("bun:sqlite")
  console.log(`Opening with bun:sqlite: ${filePath}\n`)
  const db = new Database(filePath, { readonly: true })
  try {
    run(db)
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
