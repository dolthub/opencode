import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import type { StorageAdapter, Journal } from "./db.adapter"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "db" })

class BunStatement {
  constructor(
    private readonly stmt: ReturnType<Database["prepare"]>,
    private readonly sql: string,
  ) {}

  run(...params: unknown[]) {
    try {
      const result = this.stmt.run(...params)
      log.info("query", { sql: this.sql, params, changes: result?.changes })
      return result
    } catch (err) {
      log.error("query", { sql: this.sql, params, error: err })
      throw err
    }
  }

  get(...params: unknown[]) {
    try {
      const result = this.stmt.get(...params)
      log.info("query", { sql: this.sql, params, rows: result ? 1 : 0, data: result })
      return result
    } catch (err) {
      log.error("query", { sql: this.sql, params, error: err })
      throw err
    }
  }

  all(...params: unknown[]) {
    try {
      const result = this.stmt.all(...params)
      log.info("query", { sql: this.sql, params, rows: result.length, data: result })
      return result
    } catch (err) {
      log.error("query", { sql: this.sql, params, error: err })
      throw err
    }
  }

  values(...params: unknown[]) {
    try {
      const result = this.stmt.values(...params)
      log.info("query", { sql: this.sql, params, rows: result.length, data: result })
      return result
    } catch (err) {
      log.error("query", { sql: this.sql, params, error: err })
      throw err
    }
  }
}

class BunDatabase {
  constructor(private readonly db: Database) {}

  prepare(sql: string) {
    return new BunStatement(this.db.prepare(sql), sql)
  }

  exec(sql: string) {
    try {
      this.db.exec(sql)
      log.info("query", { sql })
    } catch (err) {
      log.error("query", { sql, error: err })
      throw err
    }
  }

  transaction(fn: () => unknown) {
    return this.db.transaction(fn)
  }

  close() {
    this.db.close()
  }
}

export function computePath(filePath: string): string {
  return filePath
}

export function init(filePath: string): StorageAdapter {
  const sqlite = new Database(filePath, { create: true })
  const client = new BunDatabase(sqlite)
  const db = drizzle({ client: client as any })
  return {
    db,
    path: filePath,
    migrate: (entries: Journal) => migrate(db, entries),
    close: () => sqlite.close(),
  }
}
