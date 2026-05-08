// Used in bun environments. drizzle-orm/bun-sqlite passes statement params as
// spread args (stmt.all(...params)) while doltlite's node:sqlite-style API
// expects a single array (stmt.all(params)).  DoltliteClientAdapter bridges the
// difference so we can pass it as the `client` option to drizzle-orm/bun-sqlite.
import { DatabaseSync, StatementSync } from "@dolthub/doltlite"
import { drizzle } from "drizzle-orm/bun-sqlite"

class DoltliteStatement {
  constructor(private stmt: StatementSync) {}

  run(...args: unknown[]) {
    return this.stmt.run(args.length ? args : undefined)
  }
  all(...args: unknown[]) {
    return this.stmt.all(args.length ? args : undefined)
  }
  get(...args: unknown[]) {
    return this.stmt.get(args.length ? args : undefined)
  }
  // drizzle uses values() to get rows as ordered arrays for column-mapped results.
  values(...args: unknown[]): unknown[][] {
    const rows = this.stmt.all(args.length ? args : undefined) as Record<string, unknown>[]
    if (!rows.length) return []
    const keys = Object.keys(rows[0])
    return rows.map((row) => keys.map((k) => row[k]))
  }
}

class DoltliteClientAdapter {
  constructor(private db: DatabaseSync) {}

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
