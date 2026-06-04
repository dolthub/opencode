#!/usr/bin/env bun
/**
 * Diagnostic script: create a session (and a stub project) in an opencode database.
 *
 * Usage:
 *   bun script/create-session.ts <filepath> --sqlite
 *   bun script/create-session.ts <filepath> --doltlite
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
  bun script/create-session.ts <filepath> --sqlite
  bun script/create-session.ts <filepath> --doltlite
`)
  process.exit(1)
}

if (!values.sqlite && !values.doltlite) {
  console.error(`
Error: you must specify a backend: --sqlite or --doltlite.

Usage:
  bun script/create-session.ts <filepath> --sqlite     # open with bun:sqlite
  bun script/create-session.ts <filepath> --doltlite   # open with @dolthub/doltlite
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

function run(db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] } }) {
  const now = Date.now()
  const projectId = `proj_diag_${now}`
  const sessionId = `sess_diag_${now}`

  console.log(`Inserting project: ${projectId}`)
  db.prepare(
    `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(projectId, process.cwd(), now, now, "[]")
  console.log("  project inserted ok")

  console.log(`Inserting session: ${sessionId}`)
  db.prepare(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, projectId, "diag-session", process.cwd(), "Diagnostic Session", "0.0.0", now, now)
  console.log("  session inserted ok")

  const sessions = db.prepare("SELECT id FROM session").all() as { id: string }[]
  console.log(`\nAll sessions in DB (${sessions.length} total):`)
  for (const row of sessions) console.log(" ", row.id)
}

// ── SQLite backend ──────────────────────────────────────────────────────────

if (values.sqlite) {
  const { Database } = await import("bun:sqlite")
  console.log(`Opening with bun:sqlite: ${filePath}\n`)
  const db = new Database(filePath, { create: true })
  db.run("PRAGMA foreign_keys = ON")
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
  db.exec("PRAGMA foreign_keys = ON")
  try {
    run(db as any)
  } finally {
    db.close()
  }
  process.exit(0)
}
