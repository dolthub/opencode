import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
export * from "drizzle-orm"
import { Effect, Context } from "effect"
import { AsyncLocalStorage } from "async_hooks"
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

// ── Branch pinning ──────────────────────────────────────────────────────────
//
// Dolt's active branch is *ambient* connection state (one shared connection,
// `connectionLimit: 1`). A logical operation (a session turn, a read) spans many
// separate SQL statements, but assumes the branch stays fixed across all of
// them. Any concurrent code that flips the branch — opening another session,
// project bootstrap, a branch handler — can land a statement on the wrong
// branch, splitting one session's data across branches (and silently losing the
// part of it that's only in another branch's working set).
//
// To make branch state safe we (1) carry the *intended* branch for the current
// work in an Effect Context.Reference (inherited by forked fibers) mirrored into
// an AsyncLocalStorage (for the plain-promise read path), and (2) re-pin the
// connection to that branch immediately before every async data op, with the
// whole (check active → checkout → run) sequence serialized so no other op can
// interleave between the pin and the statement. Re-pinning per op is idempotent
// and self-correcting: even if something switched the branch away, the next op
// switches it back before it runs.
//
// When no branch is set (migrations, project bootstrap, scripts) or the adapter
// is not Dolt, pinning is skipped and behavior is identical to before.

// The intended branch for the current fiber. Provided via Effect.provideService
// around the prompt loop; inherited by forked fibers (Effect copies context on
// fork) so compaction's background writes pin to the same branch as the turn
// that spawned them.
export const CurrentBranch = Context.Reference<string | undefined>("@opencode/Database/CurrentBranch", {
  defaultValue: () => undefined,
})

// Plain-promise mirror of CurrentBranch for code that reaches the DB outside an
// Effect (the streaming read path). Set by withBranchAsync around the read body.
const branchStore = new AsyncLocalStorage<string | undefined>()

// Serializes every async adapter operation so a branch switch can never run
// between an op's pin and its statement. connectionLimit:1 serializes at the
// SQL level, but not the multi-await JS sequences (currentBranch → changeBranch
// → query) that the pin introduces, so we need this explicit FIFO queue.
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  // Keep the chain alive but swallow outcomes so one failed job can't poison the
  // queue for the next.
  queue = run.then(
    () => {},
    () => {},
  )
  return run
}

const readRetryDelays = [50, 150]

function sqlErrorMessages(err: unknown): string[] {
  if (!(err instanceof Error)) return [String(err)]
  const cause = (err as Error & { cause?: unknown; sql?: unknown; sqlMessage?: unknown }).cause
  return [
    err.message,
    typeof (err as Error & { sql?: unknown }).sql === "string" ? String((err as Error & { sql?: unknown }).sql) : undefined,
    typeof (err as Error & { sqlMessage?: unknown }).sqlMessage === "string"
      ? String((err as Error & { sqlMessage?: unknown }).sqlMessage)
      : undefined,
    ...(cause ? sqlErrorMessages(cause) : []),
  ].filter((msg): msg is string => msg !== undefined)
}

export function isReadQueryError(err: unknown): boolean {
  return sqlErrorMessages(err).some((message) => {
    const trimmed = message.trim()
    return /^select\b/i.test(trimmed) || /^failed query:\s*select\b/i.test(trimmed)
  })
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Run a data op on `branch`, re-pinning the Dolt connection first. The pin and
// the op run as one serialized job. `branch` undefined (or a non-Dolt adapter)
// means "use whatever branch is active", preserving legacy behavior.
function pinnedAsync<T>(branch: string | undefined, callback: (db: TxOrDb) => T | Promise<T>): Promise<T> {
  return enqueue(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        // Adapter() must run before awaitMigration(): it is what kicks off the
        // migration promise that awaitMigration() then waits on.
        const adapter = Adapter()
        await awaitMigration()
        if (branch && adapter.mysqlDb) {
          const active = await adapter.currentBranch()
          if (active !== branch) await adapter.changeBranch(branch)
        }
        return await callback(adapter.db)
      } catch (err) {
        if (!isReadQueryError(err) || attempt >= readRetryDelays.length) throw err
        log.warn("retrying failed read query", { branch, attempt: attempt + 1, error: err })
        await delay(readRetryDelays[attempt])
      }
    }
  })
}

// Run a plain async function with `branch` as the ambient branch for any
// Database.useAsync calls it makes. Used by the streaming read path, which is
// not Effect-based and so can't read CurrentBranch directly.
export function withBranchAsync<T>(branch: string | undefined, fn: () => Promise<T>): Promise<T> {
  return branchStore.run(branch, fn)
}

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
// migration before calling the callback with the active database, re-pinning the
// Dolt connection to the ambient branch (branchStore) first so the statement
// can't land on a branch some other concurrent op switched us to.
// For MySQL, adapter.db holds the SQLite-compat proxy created by db.mysql.ts.
export async function useAsync<T>(callback: (db: TxOrDb) => T | Promise<T>): Promise<T> {
  return pinnedAsync(branchStore.getStore(), callback)
}

export async function transactionAsync<T>(callback: (db: MySQLDB) => Promise<T>): Promise<T> {
  const branch = branchStore.getStore()
  return enqueue(async () => {
    const adapter = Adapter()
    await awaitMigration()
    if (!adapter.mysqlDb) throw new Error("transactionAsync requires MySQL adapter (OPENCODE_MYSQL_URL)")
    if (branch) {
      const active = await adapter.currentBranch()
      if (active !== branch) await adapter.changeBranch(branch)
    }
    return (adapter.mysqlDb as MySQLDB).transaction(callback as any)
  })
}

// Effect-friendly wrapper: synchronous for SQLite, async for MySQL.
// Use this inside Effect generators instead of Effect.sync(() => Database.use(...)).
// Callback is typed against the SQLite DB since all tables are SQLite-defined;
// the MySQL path casts internally so the same query code runs on both adapters.
// On the async path the op is pinned to CurrentBranch (the FiberRef set for the
// running turn) so every write lands on the session's branch.
export function useEffect<T>(callback: (db: TxOrDb) => T | Promise<T>): Effect.Effect<T> {
  if (isAsync)
    return Effect.gen(function* () {
      const branch = yield* CurrentBranch
      return yield* Effect.promise(() => pinnedAsync(branch, callback))
    })
  return Effect.sync(() => use(callback as (db: TxOrDb) => T))
}

export function commit(message: string): Effect.Effect<void> {
  return Effect.promise(() => enqueue(() => Promise.resolve(Adapter().commit(message))))
}

export function commitEmpty(message: string): Effect.Effect<void> {
  return Effect.promise(() => enqueue(() => Promise.resolve(Adapter().commitEmpty(message))))
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

export async function listBranchesWithBase(baseBranch: string) {
  return Adapter().listBranchesWithBase(baseBranch)
}

export async function getCommitLog() {
  return Adapter().getCommitLog()
}

export async function executeRaw(statement: string) {
  return enqueue(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await Adapter().executeRaw(statement)
      } catch (err) {
        const error = new Error(`Failed query: ${statement}`, { cause: err })
        if (!isReadQueryError(error) || attempt >= readRetryDelays.length) throw error
        log.warn("retrying failed raw read query", { attempt: attempt + 1, error })
        await delay(readRetryDelays[attempt])
      }
    }
  })
}

// MySQL-style escape for inlining drizzle's positional `?` params when we
// have to rewrite the SQL to include an `AS OF '…'` clause. (Drizzle's
// `sql.raw` carries no bound params, and Dolt's `AS OF` clause must appear
// inside the FROM, so we route through executeRaw with fully-inlined SQL.)
function escapeMySqlValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (typeof v === "bigint") return v.toString()
  if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace("T", " ")}'`
  const s = String(v)
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
}

type DrizzleSelectish = {
  toSQL(): { sql: string; params: unknown[] }
  all(): unknown[] | Promise<unknown[]>
  get?(): unknown | Promise<unknown>
}

/**
 * Execute a drizzle SELECT query, optionally rewriting it so each `FROM
 * <table>` becomes `FROM <table> AS OF '<asOf>'`. When `asOf` is not set the
 * query runs through drizzle normally. When set the SQL is compiled, the
 * AS OF clause is injected after each FROM, drizzle's positional params are
 * inlined as escaped literals, and the result is executed via the adapter's
 * raw SQL path. Only the mysql/Dolt adapter supports AS OF; non-mysql
 * adapters throw if `asOf` is provided.
 */
export async function selectAsOf<T>(query: DrizzleSelectish, asOf?: string): Promise<T[]> {
  if (!asOf) return (await query.all()) as T[]
  const adapter = Adapter()
  if (!adapter.mysqlDb) {
    throw new Error("AS OF is only supported on the MySQL/Dolt adapter")
  }
  const compiled = query.toSQL()
  const escapedAsOf = asOf.replace(/'/g, "''")
  const sqlWithAsOf = compiled.sql.replace(
    /\sfrom\s+(`[^`]+`)/gi,
    ` from $1 AS OF '${escapedAsOf}'`,
  )
  let i = 0
  const finalSql = sqlWithAsOf.replace(/\?/g, () => escapeMySqlValue(compiled.params[i++]))
  const result = await Promise.resolve(adapter.executeRaw(finalSql)).catch((err: unknown) => {
    throw new Error(`Failed query: ${finalSql}`, { cause: err })
  })
  if (result.kind !== "rows") return [] as T[]
  return result.rows as T[]
}

/** Same as selectAsOf, but returns the first row (or undefined). */
export async function getAsOf<T>(query: DrizzleSelectish, asOf?: string): Promise<T | undefined> {
  if (!asOf) {
    if (!query.get) return (await query.all() as T[])[0]
    return (await query.get()) as T | undefined
  }
  const rows = await selectAsOf<T>(query, asOf)
  return rows[0]
}

export async function diffStat(param1: string, param2: string) {
  return Adapter().diffStat(param1, param2)
}

// Branch-mutating ops go through the same serial queue as pinned data ops so a
// branch switch can never run between a pinned op's `active branch` check and
// its statement (which would defeat the pin). They do not themselves pin — they
// manage branches.
export async function merge(branch: string, squash: boolean = false): Promise<void> {
  await enqueue(() => Promise.resolve(Adapter().merge(branch, squash)))
}

export async function reset(ref: string): Promise<void> {
  await enqueue(() => Promise.resolve(Adapter().reset(ref)))
}

export async function checkoutNew(name: string, force: boolean = false): Promise<void> {
  await enqueue(() => Promise.resolve(Adapter().checkoutNew(name, force)))
}

export async function createBranch(name: string, startPoint: string | null, force: boolean): Promise<void> {
  await enqueue(() => Promise.resolve(Adapter().createBranch(name, startPoint, force)))
}

export async function changeBranch(name: string): Promise<void> {
  await enqueue(() => Promise.resolve(Adapter().changeBranch(name)))
}

export async function hasBranch(name: string): Promise<boolean> {
  return Adapter().hasBranch(name)
}

export * as Database from "./db"
