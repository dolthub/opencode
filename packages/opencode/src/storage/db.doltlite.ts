import { DatabaseSync, StatementSync } from "@dolthub/doltlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import type { StorageAdapter, Journal } from "./db.adapter"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "db" })

// DoltLite uses prolly trees (content-addressed storage), not SQLite B-trees.
// It cannot correctly open existing SQLite files: TEXT PRIMARY KEY tables are
// treated as WITHOUT ROWID internally, so rowid-keyed SQLite rows are misread
// (the second column receives the rowid integer instead of the payload value).
// Use a separate path suffix to avoid opening existing SQLite databases.
// Special paths (":memory:", file: URIs) are passed through unchanged.
export function doltlitePath(filePath: string): string {
  if (filePath === ":memory:" || filePath.startsWith("file:")) return filePath
  return filePath.endsWith(".db") ? filePath.slice(0, -3) + ".doltlite.db" : filePath + ".doltlite"
}

// drizzle-orm/bun-sqlite passes statement params as spread args and calls
// stmt.values() for column-mapped selects.  DoltLite's StatementSync uses the
// node:sqlite API (params as spread args too), but lacks values(). This
// adapter adds values() and the transaction() shape drizzle expects.

class DoltliteStatement {
  constructor(
    private readonly stmt: StatementSync,
    private readonly sql: string,
    private readonly connId: number,
  ) {}

  run(...params: unknown[]) {
    try {
      const result = this.stmt.run(...params)
      process.stderr.write(`[db:run] conn#${this.connId} changes=${result?.changes} sql=${this.sql}\n`)
      log.info("query", { conn: this.connId, sql: this.sql, params, changes: result?.changes })
      return result
    } catch (err) {
      log.error("query", { conn: this.connId, sql: this.sql, params, error: err })
      throw err
    }
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    try {
      const result = this.stmt.get(...params) as Record<string, unknown> | undefined
      process.stderr.write(`[db:get] conn#${this.connId} rows=${result ? 1 : 0} sql=${this.sql}\n`)
      log.info("query", { conn: this.connId, sql: this.sql, params, rows: result ? 1 : 0, data: result })
      return result
    } catch (err) {
      log.error("query", { conn: this.connId, sql: this.sql, params, error: err })
      throw err
    }
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    try {
      const result = this.stmt.all(...params) as Record<string, unknown>[]
      process.stderr.write(`[db:all] conn#${this.connId} rows=${result.length} sql=${this.sql}\n`)
      log.info("query", { conn: this.connId, sql: this.sql, params, rows: result.length, data: result })
      return result
    } catch (err) {
      log.error("query", { conn: this.connId, sql: this.sql, params, error: err })
      throw err
    }
  }

  // drizzle-orm/bun-sqlite PreparedQuery.get() calls stmt.values() for queries
  // that have a field mapping. It expects unknown[][] (one array per row, values
  // in SELECT column order). DoltLite returns plain objects, so we convert here.
  // Object.values() preserves V8 insertion order, which matches the column order
  // from DoltLite's C++ binding.
  values(...params: unknown[]): unknown[][] {
    try {
      const rows = this.stmt.all(...params) as Record<string, unknown>[]
      process.stderr.write(`[db:values] conn#${this.connId} rows=${rows.length} sql=${this.sql}\n`)
      log.info("query", { conn: this.connId, sql: this.sql, params, rows: rows.length, data: rows })
      return rows.map((row) => Object.values(row))
    } catch (err) {
      log.error("query", { conn: this.connId, sql: this.sql, params, error: err })
      throw err
    }
  }
}

let connectionCounter = 0

class DoltliteDatabase {
  private readonly connId: number
  constructor(readonly sqlite: DatabaseSync) {
    this.connId = ++connectionCounter
    process.stderr.write(`[db:open] connection #${this.connId}\n`)
  }

  prepare(sql: string): DoltliteStatement {
    return new DoltliteStatement(this.sqlite.prepare(sql), sql, this.connId)
  }

  exec(sql: string) {
    try {
      this.sqlite.exec(sql)
      process.stderr.write(`[db:exec] conn#${this.connId} ok: ${sql}\n`)
      log.info("query", { sql })
    } catch (err) {
      process.stderr.write(`[db:exec] conn#${this.connId} err: ${sql} :: ${err}\n`)
      log.error("query", { sql, error: err })
      throw err
    }
  }

  close() {
    this.sqlite.close()
  }

  // drizzle-orm/bun-sqlite calls client.transaction(fn).deferred() /
  // .immediate() / .exclusive() to run a function inside a SQLite transaction.
  //
  // exec() and prepare().run() use different internal paths in DoltLite's C++
  // binding. Using exec() for BEGIN/COMMIT means those statements run outside
  // the prepared-statement connection, so INSERT/SELECT never see each other.
  // All transaction control must go through prepare().run() to stay on the
  // same internal connection as the data operations.
  transaction(fn: () => void) {
    const run = (behavior: string) => () => {
      this.prepare(`BEGIN ${behavior}`).run()
      try {
        fn()
        this.prepare("COMMIT").run()
      } catch (err) {
        this.prepare("ROLLBACK").run()
        throw err
      }
    }
    return {
      deferred: run("DEFERRED"),
      immediate: run("IMMEDIATE"),
      exclusive: run("EXCLUSIVE"),
    }
  }
}

export function computePath(filePath: string): string {
  return doltlitePath(filePath)
}

export function init(filePath: string): StorageAdapter {
  const actualPath = doltlitePath(filePath)
  const sqlite = new DatabaseSync(actualPath)
  const client = new DoltliteDatabase(sqlite)
  const db = drizzle({ client: client as any })
  const version = (client.prepare("SELECT dolt_version() as version").get() as { version: string } | undefined)?.version
  log.info("dolt version", { version })
  return {
    db: db as any,
    path: actualPath,
    migrate: (entries: Journal) => {
      client.exec(
        `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" ` +
          `(id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC, name TEXT, applied_at TEXT)`,
      )

      const applied = new Set(
        (client.prepare(`SELECT name FROM "__drizzle_migrations"`).all() as { name: string | null }[])
          .map((r) => r.name)
          .filter((n): n is string => n !== null),
      )

      let ran = 0
      let skipped = 0
      for (const entry of entries) {
        if (applied.has(entry.name)) {
          log.info("migration already applied, skipping", { name: entry.name })
          skipped++
          continue
        }

        log.info("applying migration", { name: entry.name })
        const statements = entry.sql
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter(Boolean)

        client.prepare("BEGIN IMMEDIATE").run()
        try {
          for (const stmt of statements) {
            client.exec(stmt)
          }
          client
            .prepare(
              `INSERT INTO "__drizzle_migrations" (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)`,
            )
            .run("", entry.timestamp, entry.name, new Date().toISOString())
          client.prepare("COMMIT").run()
          ran++
        } catch (err) {
          client.prepare("ROLLBACK").run()
          throw err
        }
      }
      log.info("migrations complete", { ran, skipped })
    },
    close: () => sqlite.close(),
    supportsVersioning: () => true,
    createBranch: () => { throw new Error("not implemented") },
    changeBranch: () => { throw new Error("not implemented") },
    currentBranch: () => { throw new Error("not implemented") },
    hasBranch: () => { throw new Error("not implemented") },
    commit: (message: string): void => {
      try {
        client.prepare("SELECT dolt_commit('-Am', ?)").get(message)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!msg.toLowerCase().includes("nothing to commit")) {
          log.warn("dolt_commit failed", { error: msg })
        }
      }
    },
  }
}
