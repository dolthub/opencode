#!/usr/bin/env bun
// @ts-nocheck
/**
 * Tests whether drizzle INSERT + SELECT round-trips correctly through the
 * DoltLite adapter — the exact code path the real application uses.
 *
 * Usage:
 *   bun script/test-drizzle-roundtrip.ts <filepath> --sqlite
 *   bun script/test-drizzle-roundtrip.ts <filepath> --doltlite
 */

import { parseArgs } from "util"
import { eq } from "drizzle-orm"
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { drizzle as drizzleBun } from "drizzle-orm/bun-sqlite"
import { Database as BunDatabase } from "bun:sqlite"

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    sqlite: { type: "boolean", default: false },
    doltlite: { type: "boolean", default: false },
  },
  allowPositionals: true,
})

if (values.sqlite && values.doltlite) {
  console.error("Error: --sqlite and --doltlite are mutually exclusive.")
  process.exit(1)
}
if (!values.sqlite && !values.doltlite) {
  console.error("Error: specify --sqlite or --doltlite.")
  process.exit(1)
}
if (positionals.length !== 1) {
  console.error("Error: expected exactly one file path argument.")
  process.exit(1)
}

const filePath = positionals[0]

// ── Minimal schema matching the real project + session tables ───────────────

const ProjectTable = sqliteTable("project", {
  id: text().primaryKey(),
  worktree: text().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_url_override: text(),
  icon_color: text(),
  time_created: integer().notNull(),
  time_updated: integer().notNull(),
  time_initialized: integer(),
  sandboxes: text({ mode: "json" }).notNull().$type<string[]>(),
  commands: text({ mode: "json" }).$type<{ start?: string }>(),
})

const SessionTable = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  workspace_id: text(),
  parent_id: text(),
  slug: text().notNull(),
  directory: text().notNull(),
  path: text(),
  title: text().notNull(),
  version: text().notNull(),
  share_url: text(),
  summary_additions: integer(),
  summary_deletions: integer(),
  summary_files: integer(),
  time_created: integer().notNull(),
  time_updated: integer().notNull(),
  time_compacting: integer(),
  time_archived: integer(),
  agent: text(),
  model: text({ mode: "json" }),
  revert: text({ mode: "json" }),
  permission: text({ mode: "json" }),
  summary_diffs: text({ mode: "json" }),
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function step(label: string) {
  process.stdout.write(`\n[${label}] `)
}

function ok(msg: string) {
  console.log("OK  " + msg)
}

function fail(msg: string) {
  console.error("FAIL " + msg)
}

async function run(db: ReturnType<typeof drizzleBun>) {
  const now = Date.now()
  const projectID = `proj_drizzle_${now}`
  const sessionID = `sess_drizzle_${now}`

  // ── 1. Insert project via drizzle (with onConflictDoUpdate like real code) ─
  step("1 project INSERT via drizzle onConflictDoUpdate")
  try {
    db.insert(ProjectTable)
      .values({
        id: projectID,
        worktree: process.cwd(),
        vcs: null,
        name: null,
        icon_url: null,
        icon_url_override: null,
        icon_color: null,
        time_created: now,
        time_updated: now,
        time_initialized: null,
        sandboxes: [],
        commands: null,
      })
      .onConflictDoUpdate({
        target: ProjectTable.id,
        set: { worktree: process.cwd(), time_updated: now },
      })
      .run()
    ok(projectID)
  } catch (e) {
    fail(String(e))
    process.exit(1)
  }

  // ── 2. Read project back via drizzle SELECT ──────────────────────────────
  step("2 project SELECT via drizzle")
  try {
    const row = db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()
    if (!row) {
      fail("returned undefined — project not found after INSERT")
      process.exit(1)
    }
    ok(`id=${row.id}  worktree=${row.worktree}`)
  } catch (e) {
    fail(String(e))
    process.exit(1)
  }

  // ── 3. Insert session via drizzle inside an IMMEDIATE transaction ─────────
  step("3 session INSERT via drizzle transaction (behavior=immediate)")
  try {
    db.transaction(
      (tx) => {
        tx.insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: "drizzle-test",
            directory: process.cwd(),
            title: "Drizzle Round-Trip Test",
            version: "0.0.0",
            time_created: now,
            time_updated: now,
          })
          .run()
      },
      { behavior: "immediate" },
    )
    ok(sessionID)
  } catch (e) {
    fail(String(e))
    process.exit(1)
  }

  // ── 4. Read session back via drizzle SELECT (same as Session.get) ─────────
  step("4 session SELECT via drizzle (full select().from().where().get())")
  try {
    const row = db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
    if (!row) {
      fail("returned undefined — session not found after INSERT")
      process.exit(1)
    }
    ok(`id=${row.id}  title=${row.title}  project_id=${row.project_id}`)
  } catch (e) {
    fail(String(e))
    process.exit(1)
  }

  // ── 5. List all sessions (same as Session.list) ───────────────────────────
  step("5 session SELECT all via drizzle select().from().all()")
  try {
    const rows = db.select().from(SessionTable).all()
    ok(`found ${rows.length} session(s), IDs: ${rows.map((r) => r.id).join(", ")}`)
  } catch (e) {
    fail(String(e))
    process.exit(1)
  }

  console.log("\n✓ All steps passed.")
}

// ── SQLite backend ────────────────────────────────────────────────────────────

if (values.sqlite) {
  console.log(`Opening with bun:sqlite: ${filePath}`)
  const sqlite = new BunDatabase(filePath, { create: true })
  const db = drizzleBun({ client: sqlite })
  try {
    await run(db)
  } finally {
    sqlite.close()
  }
  process.exit(0)
}

// ── DoltLite backend ─────────────────────────────────────────────────────────

if (values.doltlite) {
  // Use DoltliteDatabase + drizzle directly (same as init() but with the path
  // taken as-is so the caller can pass either the logical or actual path)
  const { DatabaseSync } = await import("@dolthub/doltlite")
  const { drizzle } = await import("drizzle-orm/bun-sqlite")

  // Resolve actual path the same way init() does, but only if not already transformed
  const { doltlitePath } = await import("../src/storage/db.doltlite.ts")
  const actualPath = filePath.endsWith(".doltlite.db") ? filePath : doltlitePath(filePath)
  console.log(`Opening with DoltLite adapter: ${actualPath}`)

  const { default: DoltliteDBModule } = await import("../src/storage/db.doltlite.ts")
  // Use init() with the actual path directly by temporarily bypassing the path transform
  const sqlite = new DatabaseSync(actualPath)

  // Minimal DoltliteDatabase/Statement wrappers (same as db.doltlite.ts)
  class Stmt {
    constructor(private s: any) {}
    run(...p: unknown[]) { return this.s.run(...p) }
    get(...p: unknown[]) { return this.s.get(...p) }
    all(...p: unknown[]) { return this.s.all(...p) }
    values(...p: unknown[]): unknown[][] {
      return (this.s.all(...p) as Record<string, unknown>[]).map(Object.values)
    }
  }
  const client = {
    prepare: (sql: string) => new Stmt(sqlite.prepare(sql)),
    exec: (sql: string) => sqlite.exec(sql),
    close: () => sqlite.close(),
    transaction: (fn: () => void) => {
      const run = (behavior: string) => () => {
        sqlite.exec(`BEGIN ${behavior}`)
        try { fn(); sqlite.exec("COMMIT") }
        catch (err) { sqlite.exec("ROLLBACK"); throw err }
      }
      return { deferred: run("DEFERRED"), immediate: run("IMMEDIATE"), exclusive: run("EXCLUSIVE") }
    },
  }
  const db = drizzle({ client: client as any })

  try {
    await run(db as any)
  } finally {
    sqlite.close()
  }
  process.exit(0)
}
