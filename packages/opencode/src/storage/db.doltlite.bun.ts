// Used in bun environments. drizzle-orm/bun-sqlite passes statement params as
// spread args (stmt.all(...params)) while doltlite's node:sqlite-style API
// expects a single array (stmt.all(params)).  DoltliteClientAdapter bridges the
// difference so we can pass it as the `client` option to drizzle-orm/bun-sqlite.
import { DatabaseSync, StatementSync } from "@dolthub/doltlite"
import { drizzle } from "drizzle-orm/bun-sqlite"

// Tables whose writes should each produce a Dolt commit.
const TRACKED = new Set(["session", "message", "part", "todo", "session_message", "permission"])

interface WriteOp {
  table: string
  op: "insert" | "update" | "delete"
}

// Parse the table name and DML type from a prepared statement's SQL text.
// Returns null for SELECTs, DDL, or writes to untracked tables.
function parseWriteOp(sql: string): WriteOp | null {
  const s = sql.trimStart()
  let m: RegExpMatchArray | null

  m = s.match(/^insert\s+(?:or\s+\w+\s+)?into\s+"?(\w+)"?/i)
  if (m && TRACKED.has(m[1])) return { table: m[1], op: "insert" }

  m = s.match(/^update\s+"?(\w+)"?/i)
  if (m && TRACKED.has(m[1])) return { table: m[1], op: "update" }

  m = s.match(/^delete\s+from\s+"?(\w+)"?/i)
  if (m && TRACKED.has(m[1])) return { table: m[1], op: "delete" }

  return null
}

// Build a ≤120-char commit message from a list of write ops.
function buildMessage(ops: WriteOp[]): string {
  const counts = new Map<string, number>()
  for (const { op, table } of ops) {
    const key = `${op} ${table}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const parts = Array.from(counts.entries()).map(([key, n]) => (n === 1 ? key : `${key} ×${n}`))
  const msg = parts.join(", ")
  return msg.length <= 120 ? msg : msg.slice(0, 117) + "..."
}

class DoltliteStatement {
  private readonly writeOp: WriteOp | null

  constructor(
    private readonly stmt: StatementSync,
    sql: string,
    private readonly adapter: DoltliteClientAdapter,
  ) {
    this.writeOp = parseWriteOp(sql)
  }

  run(...args: unknown[]) {
    const result = this.stmt.run(args.length ? args : undefined)
    if (this.writeOp && result.changes > 0) {
      this.adapter.onWrite(this.writeOp)
    }
    return result
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
  private inTx = false
  private txOps: WriteOp[] = []

  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string) {
    return new DoltliteStatement(this.db.prepare(sql), sql, this)
  }
  exec(query: string) {
    this.db.exec(query)
  }
  close() {
    this.db.close()
  }

  // Called by DoltliteStatement.run() whenever a tracked write lands.
  onWrite(op: WriteOp) {
    if (this.inTx) {
      this.txOps.push(op)
    } else {
      this.db.doltCommit(buildMessage([op]))
    }
  }

  // bun:sqlite's Database.transaction() returns an object with .deferred(),
  // .immediate(), .exclusive() — drizzle calls one of them to run the txn.
  transaction(fn: () => void) {
    const db = this.db
    const adapter = this
    const run = (behavior: string) => () => {
      db.exec(`BEGIN ${behavior}`)
      adapter.inTx = true
      adapter.txOps = []
      try {
        fn()
        db.exec("COMMIT")
        const ops = adapter.txOps.slice()
        adapter.inTx = false
        adapter.txOps = []
        if (ops.length > 0) db.doltCommit(buildMessage(ops))
      } catch (err) {
        adapter.inTx = false
        adapter.txOps = []
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
