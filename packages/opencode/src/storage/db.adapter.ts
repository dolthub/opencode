import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"

export type DB = BaseSQLiteDatabase<"sync", void>

export type Journal = { sql: string; timestamp: number; name: string }[]

export interface StorageAdapter {
  readonly db: DB
  // Set by the MySQL adapter; callers use Database.useAsync() to access it
  readonly mysqlDb?: object
  readonly path: string
  migrate(entries: Journal): void | Promise<void>
  close(): void | Promise<void>
}
