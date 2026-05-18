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

// Determine desired adapter from argv at module load time, before yargs runs.
const _wantsDolt = process.argv.includes("--dolt") || !!process.env.OPENCODE_MYSQL_URL
const _wantsDoltlite = process.argv.includes("--doltlite")

// Conditional imports keep unused adapters out of the default bundle.
const MySQLModule = _wantsDolt ? await import("./db.mysql") : null
const DoltliteModule = _wantsDoltlite ? await import("./db.doltlite") : null

// Pending migration promise for async adapters (MySQL).
// Awaited by useAsync/transactionAsync before the first query.
let _migrationPromise: Promise<void> | undefined

function getMigrationEntries(): Journal {
  return typeof OPENCODE_MIGRATIONS !== "undefined"
    ? OPENCODE_MIGRATIONS
    : migrations(path.join(import.meta.dirname, "../../migration"))
}

const Adapter = lazy((): StorageAdapter => {
  if (_wantsDolt && MySQLModule) {
    const url = process.env.OPENCODE_MYSQL_URL
    if (!url) throw new Error("OPENCODE_MYSQL_URL is not set; required for --dolt")
    log.info("opening database", { driver: "mysql" })
    const adapter = MySQLModule.init(url)
    const result = adapter.migrate([])
    if (result instanceof Promise) _migrationPromise = result
    return adapter
  }

  if (_wantsDoltlite && DoltliteModule) {
    log.info("opening database", { driver: "doltlite", path: Path })
    const adapter = DoltliteModule.init(Path)
    const entries = getMigrationEntries()
    if (entries.length > 0) {
      log.info("applying migrations", {
        count: entries.length,
        mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      if (Flag.OPENCODE_SKIP_MIGRATIONS) {
        for (const item of entries) item.sql = "select 1;"
      }
      adapter.migrate(entries)
    }
    return adapter
  }

  log.info("opening database", { path: Path })

  const adapter = init(Path)
  const { db } = adapter

  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA cache_size = -64000")
  db.run("PRAGMA foreign_keys = ON")

  const entries = getMigrationEntries()
  if (entries.length > 0) {
    log.info("applying migrations", {
      count: entries.length,
      mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
    })
    if (Flag.OPENCODE_SKIP_MIGRATIONS) {
      for (const item of entries) item.sql = "select 1;"
    }
    adapter.migrate(entries)
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
export const isAsync = _wantsDolt

// True when json migration should be skipped (non-sqlite backends start fresh).
export const skipJsonMigration = _wantsDolt || _wantsDoltlite

// Pure path computation — no DB side effects.
export function adapterPath(): string {
  if (_wantsDolt) return process.env.OPENCODE_MYSQL_URL ?? ""
  if (_wantsDoltlite && DoltliteModule) return DoltliteModule.computePath(Path)
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

// Delegates to the active adapter's doltCommit. No-ops on plain SQLite;
// uses SELECT on DoltLite and CALL on MySQL/Dolt-server.
export function doltCommit(message: string): Effect.Effect<void> {
  return Effect.promise(() => Promise.resolve(Adapter().doltCommit(message)))
}

// Resets the current branch to the given ref (branch name or commit hash).
// Only supported on versioning-capable adapters (Dolt/MySQL); no-ops otherwise.
export function doltReset(ref: string): Effect.Effect<void> {
  return Effect.promise(() => Promise.resolve(Adapter().doltReset?.(ref)))
}

export function supportsVersioning(): boolean {
  return Adapter().supportsVersioning()
}

export async function createBranch(name: string, startPoint: string | null = null, force: boolean = false): Promise<void> {
  await Adapter().createBranch(name, startPoint, force)
}

export async function changeBranch(name: string): Promise<void> {
  await Adapter().changeBranch(name)
}

export async function hasBranch(name: string): Promise<boolean> {
  return Adapter().hasBranch(name)
}

export * as Database from "./db"
