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
  doltCommit(message: string): void | Promise<void>
  supportsVersioning(): boolean
  createBranch(name: string, startPoint: string | null, force: boolean): void | Promise<void>
  changeBranch(name: string): void | Promise<void>
  currentBranch(): string | Promise<string>
  hasBranch(name: string): boolean | Promise<boolean>
}
