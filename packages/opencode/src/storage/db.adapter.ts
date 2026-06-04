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
  commit(message: string): void | Promise<void>
  commitEmpty(message: string): void | Promise<void>
  createBranch(name: string, startPoint: string | null, force: boolean): void | Promise<void>
  checkoutNew(name: string, force?: boolean): void | Promise<void>
  changeBranch(name: string): void | Promise<void>
  currentBranch(): string | Promise<string>
  hasBranch(name: string): boolean | Promise<boolean>
  branchHash(branch: string): string | Promise<string>
  hasCommitInHistory(branch: string, commit: string): boolean | Promise<boolean>
  isDirty(): boolean | Promise<boolean>
  listBranchesWithBase(baseBranch: string): BranchInfo[] | Promise<BranchInfo[]>
  getCommitLog(): CommitLogEntry[] | Promise<CommitLogEntry[]>
  executeRaw(statement: string): RawResult | Promise<RawResult>
  diffStat(param1: string, param2: string): DiffStat[] | Promise<DiffStat[]>
  merge(branch: string, squash?: boolean): void | Promise<void>
  reset(ref: string): void | Promise<void>
}

export interface BranchInfo {
  name: string
  commitHash: string
  commitMessage: string
}

export type RawResult =
  | { kind: "rows"; columns: string[]; rows: Array<Record<string, unknown>> }
  | { kind: "result"; affectedRows?: number; insertId?: number | string; info?: string }

export interface DiffStat {
  tableName: string
  rowsUnmodified: number
  rowsAdded: number
  rowsDeleted: number
  rowsModified: number
  cellsAdded: number
  cellsDeleted: number
  cellsModified: number
  oldRowCount: number
  newRowCount: number
  oldCellCount: number
  newCellCount: number
  // Byte-size of the `data` JSON column across changed rows. Zero for tables
  // that don't have a `data` column (e.g. todo).
  oldDataBytes: number
  newDataBytes: number
  dataBytesAdded: number
  dataBytesDeleted: number
  dataBytesModifiedDelta: number
}

export interface CommitLogEntry {
  commitHash: string
  date: Date
  message: string
}
