// Used in bun environments. drizzle-orm/bun-sqlite expects two methods that
// doltlite-node's node:sqlite-style API doesn't have:
//   - client.transaction(fn).immediate() — bun:sqlite's transaction shape
//   - stmt.values(...params)              — bun:sqlite's rows-as-arrays accessor
// DoltliteClientAdapter polyfills both. It also bridges the spread-vs-single-
// array param convention (drizzle spreads, doltlite-node expects an array).
//
// NOTE: this adapter does NOT auto-create dolt commits per write. Auto-commit
// per transaction is expensive (each one stages all tables and writes a new
// root) and surprised opencode's read-after-write semantics. Dolt history is
// captured explicitly higher in the stack — see snapshot points in db.ts and
// service-shutdown paths.
import { DatabaseSync, StatementSync } from "@dolthub/doltlite"
import { drizzle } from "drizzle-orm/bun-sqlite"

class DoltliteStatement {
  constructor(private readonly stmt: StatementSync) {}

  run(...args: unknown[]) {
    return this.stmt.run(args.length ? args : undefined)
  }
  all(...args: unknown[]) {
    return this.stmt.all(args.length ? args : undefined)
  }
  get(...args: unknown[]) {
    return this.stmt.get(args.length ? args : undefined)
  }
  // drizzle-bun-sqlite calls stmt.values() to get rows as ordered arrays.
  values(...args: unknown[]): unknown[][] {
    const rows = this.stmt.all(args.length ? args : undefined) as Record<string, unknown>[]
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    return rows.map((row) => keys.map((k) => row[k]))
  }
}

class DoltliteClientAdapter {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string) {
    return new DoltliteStatement(this.db.prepare(sql))
  }
  exec(query: string) {
    this.db.exec(query)
  }
  close() {
    this.db.close()
  }

  // bun:sqlite's Database.transaction() returns an object with .deferred(),
  // .immediate(), .exclusive() — drizzle calls one of them to run the txn.
  transaction(fn: () => void) {
    const db = this.db
    const run = (behavior: string) => () => {
      db.exec(`BEGIN ${behavior}`)
      try {
        fn()
        db.exec("COMMIT")
      } catch (err) {
        db.exec("ROLLBACK")
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

export function init(path: string) {
  const sqlite = new DatabaseSync(path)
  const client = new DoltliteClientAdapter(sqlite)
  return drizzle({ client: client as any })
}
