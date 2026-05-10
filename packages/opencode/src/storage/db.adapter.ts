import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"

export type DB = BaseSQLiteDatabase<"sync", void>

export type Journal = { sql: string; timestamp: number; name: string }[]

export interface StorageAdapter {
  readonly db: DB
  readonly path: string
  migrate(entries: Journal): void
  close(): void
}
