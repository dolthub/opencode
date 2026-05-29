import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
export * from "drizzle-orm"
import { Effect } from "effect"
import { LocalContext } from "@/util/local-context"
import { lazy } from "../util/lazy"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { NamedError } from "@opencode-ai/core/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import { Flag } from "@opencode-ai/core/flag/flag"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { InstanceState } from "@/effect/instance-state"
import { iife } from "@/util/iife"
import { init, computePath } from "#db"
import type { DB, Journal, StorageAdapter } from "./db.adapter"
import type { MySql2Database } from "drizzle-orm/mysql2"
export type { DB, StorageAdapter }

export type MySQLDB = MySql2Database
// AnyDB is kept as an alias for DB because all tables are SQLite-defined.
// The MySQL adapter accepts the same Drizzle queries via a runtime cast in useAsync.
export type AnyDB = DB

declare const OPENCODE_MIGRATIONS: Journal | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export function getChannelPath() {
  if (["latest", "beta", "prod"].includes(InstallationChannel) || Flag.OPENCODE_DISABLE_CHANNEL_DB)
    return path.join(Global.Path.data, "opencode.db")
  const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
  return path.join(Global.Path.data, `opencode-${safe}.db`)
}

export const Path = iife(() => {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || path.isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return path.join(Global.Path.data, Flag.OPENCODE_DB)
  }
  return getChannelPath()
})

export type Transaction = SQLiteTransaction<"sync", void>
export type TxOrDb = DB

function time(tag: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
  if (!match) return 0
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
}

function migrations(dir: string): Journal {
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  const sql = dirs
    .map((name) => {
      const file = path.join(dir, name, "migration.sql")
      if (!existsSync(file)) return
      return {
        sql: readFileSync(file, "utf-8"),
        timestamp: time(name),
        name,
      }
    })
    .filter(Boolean) as Journal

  return sql.sort((a, b) => a.timestamp - b.timestamp)
}

// Loaded lazily when OPENCODE_MYSQL_URL is set. The conditional prevents
// mysql2 from being bundled or imported when MySQL is not configured.
const MySQLModule = Flag.OPENCODE_MYSQL_URL ? await import("./db.mysql") : null

// Pending migration promise for async adapters (MySQL).
// Awaited by useAsync/transactionAsync before the first query.
let _migrationPromise: Promise<void> | undefined

// Validates that the storage is in a clean state on 'main' before write work
// runs. Pass the adapter explicitly when calling from inside the lazy
// Adapter() initializer to avoid re-entering it.
export async function preMigrate(adapter: StorageAdapter = Adapter()): Promise<void> {
  const initialBranch = await adapter.currentBranch()
  if (initialBranch !== "main") {
    throw new Error(`Expected to be on 'main' branch, but on '${initialBranch}'`)
  }
  if (await adapter.isDirty()) {
    throw new Error("Cannot proceed: working set is dirty")
  }
}

// Commits any pending changes with `message`. Pass the adapter explicitly
// when calling from inside the lazy Adapter() initializer.
export async function postMigrate(
  message: string,
  adapter: StorageAdapter = Adapter(),
): Promise<void> {
  if (await adapter.isDirty()) {
    await adapter.commit(message)
  }
}

const Adapter = lazy((): StorageAdapter => {
  if (MySQLModule && Flag.OPENCODE_MYSQL_URL) {
    log.info("opening database", { driver: "mysql" })
    const adapter = MySQLModule.init(Flag.OPENCODE_MYSQL_URL)
    _migrationPromise = (async () => {
      await preMigrate(adapter)
      await adapter.migrate([])
      await postMigrate("migration changes", adapter)
    })()
    return adapter
  }

  log.info("opening database", { path: Path })

  const adapter = init(Path)
  const { db } = adapter

  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA cache_size = -64000")
  db.run("PRAGMA foreign_keys = ON")

  const entries =
    typeof OPENCODE_MIGRATIONS !== "undefined"
      ? OPENCODE_MIGRATIONS
      : migrations(path.join(import.meta.dirname, "../../migration"))
  if (entries.length > 0) {
    log.info("applying migrations", {
      count: entries.length,
      mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
    })
    if (Flag.OPENCODE_SKIP_MIGRATIONS) {
      for (const item of entries) {
        item.sql = "select 1;"
      }
    }
    let didCheckoutNew = false
    if (adapter.isDirty() === true) {
      adapter.checkoutNew("migration", true)
      if (adapter.isDirty() === true) {
        adapter.commit("temp migration commit")
      }
      adapter.changeBranch("main")
      didCheckoutNew = true
    }
    adapter.migrate(entries)
    if (adapter.isDirty() === true) {
      adapter.commit("migration changes")
    }
    if (didCheckoutNew) {
      adapter.merge("migration", true)
    }
  }

  return adapter
})

export const Client = Object.assign(
  (): DB => {
    const adapter = Adapter()
    if (adapter.mysqlDb) throw new Error("Cannot use synchronous Client() with MySQL adapter; use Database.useAsync() instead")
    return adapter.db
  },
  {
    loaded: () => Adapter.loaded(),
    reset: () => Adapter.reset(),
  },
)

// True when the active adapter is async (MySQL). Callers that are SQLite-only
// (e.g. JsonMigration) should gate on this before using Database.Client().
export const isAsync = !!(MySQLModule && Flag.OPENCODE_MYSQL_URL)

// Pure path computation — no DB side effects.
export function adapterPath(): string {
  if (Flag.OPENCODE_MYSQL_URL) return Flag.OPENCODE_MYSQL_URL
  return computePath(Path)
}

// Returns the path the adapter is actually using (may differ from Path when
// the backend uses a path suffix, e.g. DoltLite uses ".doltlite.db").
// Initializes the adapter as a side effect.
export function getAdapterPath(): string {
  return Adapter().path
}

export function close() {
  if (!Adapter.loaded()) return
  const result = Adapter().close()
  Adapter.reset()
  return result
}

const ctx = LocalContext.create<{
  tx: TxOrDb
  effects: (() => void | Promise<void>)[]
}>("database")

export function use<T>(callback: (trx: TxOrDb) => T): T {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
      for (const effect of effects) effect()
      return result
    }
    throw err
  }
}

export function effect(fn: () => any | Promise<any>) {
  const bound = InstanceState.bind(fn)
  try {
    ctx.use().effects.push(bound)
  } catch {
    bound()
  }
}

type NotPromise<T> = T extends Promise<any> ? never : T

export function transaction<T>(
  callback: (tx: TxOrDb) => NotPromise<T>,
  options?: {
    behavior?: "deferred" | "immediate" | "exclusive"
  },
): NotPromise<T> {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const txCallback = InstanceState.bind((tx: TxOrDb) => ctx.provide({ tx, effects }, () => callback(tx)))
      const result = Client().transaction(txCallback, { behavior: options?.behavior })
      for (const effect of effects) effect()
      return result as NotPromise<T>
    }
    throw err
  }
}

async function awaitMigration() {
  if (_migrationPromise) {
    await _migrationPromise
    _migrationPromise = undefined
  }
}

// Async variant for MySQL (and optionally SQLite). Awaits any pending
// migration before calling the callback with the active database.
// For MySQL, adapter.db holds the SQLite-compat proxy created by db.mysql.ts.
export async function useAsync<T>(callback: (db: TxOrDb) => T | Promise<T>): Promise<T> {
  const db = Adapter().db
  await awaitMigration()
  return callback(db)
}

export async function transactionAsync<T>(callback: (db: MySQLDB) => Promise<T>): Promise<T> {
  await awaitMigration()
  const adapter = Adapter()
  if (!adapter.mysqlDb) throw new Error("transactionAsync requires MySQL adapter (OPENCODE_MYSQL_URL)")
  return (adapter.mysqlDb as MySQLDB).transaction(callback as any)
}

// Effect-friendly wrapper: synchronous for SQLite, async for MySQL.
// Use this inside Effect generators instead of Effect.sync(() => Database.use(...)).
// Callback is typed against the SQLite DB since all tables are SQLite-defined;
// the MySQL path casts internally so the same query code runs on both adapters.
export function useEffect<T>(callback: (db: TxOrDb) => T | Promise<T>): Effect.Effect<T> {
  if (isAsync) return Effect.promise(() => useAsync(callback))
  return Effect.sync(() => use(callback as (db: TxOrDb) => T))
}

export function commit(message: string): Effect.Effect<void> {
  return Effect.promise(() => Promise.resolve(Adapter().commit(message)))
}

export function commitEmpty(message: string): Effect.Effect<void> {
  return Effect.promise(() => Promise.resolve(Adapter().commitEmpty(message)))
}

export async function isDirty(): Promise<boolean> {
  return Adapter().isDirty()
}

export async function hasCommitInHistory(branch: string, commit: string): Promise<boolean> {
  return Adapter().hasCommitInHistory(branch, commit)
}

export async function branchHash(branch: string): Promise<string> {
  return Adapter().branchHash(branch)
}

export async function currentBranch(): Promise<string> {
  return Adapter().currentBranch()
}

export async function listBranchesWithBase(baseBranch: string): Promise<string[]> {
  return Adapter().listBranchesWithBase(baseBranch)
}

export async function getCommitLog() {
  return Adapter().getCommitLog()
}

export async function executeRaw(statement: string) {
  return Adapter().executeRaw(statement)
}

export async function diffStat(param1: string, param2: string) {
  return Adapter().diffStat(param1, param2)
}

export async function merge(branch: string, squash: boolean = false): Promise<void> {
  await Adapter().merge(branch, squash)
}

export async function checkoutNew(name: string, force: boolean = false): Promise<void> {
  await Adapter().checkoutNew(name, force)
}

export async function createBranch(name: string, startPoint: string | null, force: boolean): Promise<void> {
  await Adapter().createBranch(name, startPoint, force)
}

export async function changeBranch(name: string): Promise<void> {
  await Adapter().changeBranch(name)
}

export async function hasBranch(name: string): Promise<boolean> {
  return Adapter().hasBranch(name)
}

export * as Database from "./db"
