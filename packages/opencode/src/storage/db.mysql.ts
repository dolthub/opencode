import { mysqlTable, varchar, text, int, bigint, json, boolean, index, primaryKey } from "drizzle-orm/mysql-core"
import { drizzle } from "drizzle-orm/mysql2"
import { sql } from "drizzle-orm"
import type { MySql2Database } from "drizzle-orm/mysql2"
import mysql, { type Connection } from "mysql2/promise"
import * as Log from "@opencode-ai/core/util/log"
import type { StorageAdapter, Journal, DB } from "./db.adapter"
import { SQLiteTextJson } from "drizzle-orm/sqlite-core"

// mysql2 returns JSON columns as already-parsed JS values. drizzle-orm's SQLite
// json column mapper calls JSON.parse() unconditionally. Patch it to pass through
// non-string values so MySQL objects are not double-parsed.
;(SQLiteTextJson.prototype as any).mapFromDriverValue = function (value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value)
  return value
}

const log = Log.create({ service: "db" })

// drizzle-orm wraps mysql2 errors as "Failed query: ..." and stashes the
// real driver error on `.cause`. The actual Dolt/MySQL text lives on
// `cause.sqlMessage`. Walk the chain so callers see the underlying reason.
function unwrapSqlError(e: unknown): string {
  const inner = e instanceof Error ? ((e as any).cause ?? e) : e
  if (inner instanceof Error) {
    return (inner as any).sqlMessage ?? inner.message
  }
  return String(inner)
}

// ── Drizzle logger ────────────────────────────────────────────────────────────

const drizzleLogger = {
  logQuery(query: string, params: unknown[]) {
    log.info("query", { sql: query, params })
  },
}

// ── Schema ────────────────────────────────────────────────────────────────────

export const ProjectTable = mysqlTable("project", {
  id: varchar({ length: 255 }).primaryKey(),
  worktree: text().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_url_override: text(),
  icon_color: text(),
  base_branch: varchar({ length: 256 }),
  time_created: bigint({ mode: "number" }).notNull(),
  time_updated: bigint({ mode: "number" }).notNull(),
  time_initialized: bigint({ mode: "number" }),
  sandboxes: json().notNull().$type<string[]>(),
  commands: json().$type<{ start?: string }>(),
})

export const SessionTable = mysqlTable(
  "session",
  {
    id: varchar({ length: 255 }).primaryKey(),
    project_id: varchar({ length: 255 })
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: varchar({ length: 255 }),
    parent_id: varchar({ length: 255 }),
    slug: varchar({ length: 255 }).notNull(),
    directory: text().notNull(),
    path: text(),
    title: text().notNull(),
    version: varchar({ length: 50 }).notNull(),
    branch: varchar({ length: 256 }),
    share_url: text(),
    summary_additions: int(),
    summary_deletions: int(),
    summary_files: int(),
    summary_diffs: json(),
    revert: json(),
    permission: json(),
    agent: text(),
    model: json(),
    time_created: bigint({ mode: "number" }).notNull(),
    time_updated: bigint({ mode: "number" }).notNull(),
    time_compacting: bigint({ mode: "number" }),
    time_archived: bigint({ mode: "number" }),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
  ],
)

export const MessageTable = mysqlTable(
  "message",
  {
    id: varchar({ length: 255 }).primaryKey(),
    session_id: varchar({ length: 255 })
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    time_created: bigint({ mode: "number" }).notNull(),
    time_updated: bigint({ mode: "number" }).notNull(),
    data: json().notNull(),
  },
  (table) => [index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id)],
)

export const PartTable = mysqlTable(
  "part",
  {
    id: varchar({ length: 255 }).primaryKey(),
    message_id: varchar({ length: 255 })
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: varchar({ length: 255 }).notNull(),
    time_created: bigint({ mode: "number" }).notNull(),
    time_updated: bigint({ mode: "number" }).notNull(),
    data: json().notNull(),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)

export const TodoTable = mysqlTable(
  "todo",
  {
    session_id: varchar({ length: 255 })
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: varchar({ length: 50 }).notNull(),
    priority: varchar({ length: 50 }).notNull(),
    position: int().notNull(),
    time_created: bigint({ mode: "number" }).notNull(),
    time_updated: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = mysqlTable(
  "session_message",
  {
    id: varchar({ length: 255 }).primaryKey(),
    session_id: varchar({ length: 255 })
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: varchar({ length: 100 }).notNull(),
    time_created: bigint({ mode: "number" }).notNull(),
    time_updated: bigint({ mode: "number" }).notNull(),
    data: json().notNull(),
  },
  (table) => [
    index("session_message_session_idx").on(table.session_id),
    index("session_message_session_type_idx").on(table.session_id, table.type),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const PermissionTable = mysqlTable("permission", {
  project_id: varchar({ length: 255 })
    .primaryKey()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  time_created: bigint({ mode: "number" }).notNull(),
  time_updated: bigint({ mode: "number" }).notNull(),
  data: json().notNull(),
})

export const EventSequenceTable = mysqlTable("event_sequence", {
  aggregate_id: varchar({ length: 255 }).notNull().primaryKey(),
  seq: int().notNull(),
  owner_id: varchar({ length: 255 }),
})

export const EventTable = mysqlTable("event", {
  id: varchar({ length: 255 }).primaryKey(),
  aggregate_id: varchar({ length: 255 })
    .notNull()
    .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
  seq: int().notNull(),
  type: varchar({ length: 255 }).notNull(),
  data: json().notNull(),
})

export const AccountTable = mysqlTable("account", {
  id: varchar({ length: 255 }).primaryKey(),
  email: text().notNull(),
  url: text().notNull(),
  access_token: text().notNull(),
  refresh_token: text().notNull(),
  token_expiry: bigint({ mode: "number" }),
  time_created: bigint({ mode: "number" }).notNull(),
  time_updated: bigint({ mode: "number" }).notNull(),
})

export const AccountStateTable = mysqlTable("account_state", {
  id: int().primaryKey().autoincrement(),
  active_account_id: varchar({ length: 255 }).references(() => AccountTable.id, { onDelete: "set null" }),
  active_org_id: varchar({ length: 255 }),
})

export const ControlAccountTable = mysqlTable(
  "control_account",
  {
    email: varchar({ length: 255 }).notNull(),
    url: varchar({ length: 255 }).notNull(),
    access_token: text().notNull(),
    refresh_token: text().notNull(),
    token_expiry: bigint({ mode: "number" }),
    active: boolean().notNull().default(false),
    time_created: bigint({ mode: "number" }).notNull(),
    time_updated: bigint({ mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.email, table.url] })],
)

export const WorkspaceTable = mysqlTable("workspace", {
  id: varchar({ length: 255 }).primaryKey(),
  type: varchar({ length: 100 }).notNull(),
  name: text().notNull().default(""),
  branch: text(),
  directory: text(),
  extra: json(),
  project_id: varchar({ length: 255 })
    .notNull()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
})

export const SessionShareTable = mysqlTable("session_share", {
  session_id: varchar({ length: 255 })
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  id: varchar({ length: 255 }).notNull(),
  secret: text().notNull(),
  url: text().notNull(),
  time_created: bigint({ mode: "number" }).notNull(),
  time_updated: bigint({ mode: "number" }).notNull(),
})

// ── DDL (ordered by FK dependency) ───────────────────────────────────────────

const DDL = [
  `CREATE TABLE IF NOT EXISTS \`project\` (
    \`id\` VARCHAR(255) NOT NULL,
    \`worktree\` TEXT NOT NULL,
    \`vcs\` TEXT,
    \`name\` TEXT,
    \`icon_url\` TEXT,
    \`icon_url_override\` TEXT,
    \`icon_color\` TEXT,
    \`base_branch\` VARCHAR(256),
    \`time_created\` BIGINT NOT NULL,
    \`time_updated\` BIGINT NOT NULL,
    \`time_initialized\` BIGINT,
    \`sandboxes\` JSON NOT NULL,
    \`commands\` JSON,
    PRIMARY KEY (\`id\`)
  )`,

  `CREATE TABLE IF NOT EXISTS \`account\` (
    \`id\` VARCHAR(255) NOT NULL,
    \`email\` TEXT NOT NULL,
    \`url\` TEXT NOT NULL,
    \`access_token\` TEXT NOT NULL,
    \`refresh_token\` TEXT NOT NULL,
    \`token_expiry\` BIGINT,
    \`time_created\` BIGINT NOT NULL,
    \`time_updated\` BIGINT NOT NULL,
    PRIMARY KEY (\`id\`)
  )`,

  `CREATE TABLE IF NOT EXISTS \`event_sequence\` (
    \`aggregate_id\` VARCHAR(255) NOT NULL,
    \`seq\` INT NOT NULL,
    \`owner_id\` VARCHAR(255),
    PRIMARY KEY (\`aggregate_id\`)
  )`,

  `CREATE TABLE IF NOT EXISTS \`control_account\` (
    \`email\` VARCHAR(255) NOT NULL,
    \`url\` VARCHAR(255) NOT NULL,
    \`access_token\` TEXT NOT NULL,
    \`refresh_token\` TEXT NOT NULL,
    \`token_expiry\` BIGINT,
    \`active\` TINYINT(1) NOT NULL DEFAULT 0,
    \`time_created\` BIGINT NOT NULL,
    \`time_updated\` BIGINT NOT NULL,
    PRIMARY KEY (\`email\`, \`url\`)
  )`,

  `CREATE TABLE IF NOT EXISTS \`account_state\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`active_account_id\` VARCHAR(255),
    \`active_org_id\` VARCHAR(255),
    PRIMARY KEY (\`id\`),
    FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\` (\`id\`) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS \`session\` (
    \`id\` VARCHAR(255) NOT NULL,
    \`project_id\` VARCHAR(255) NOT NULL,
    \`workspace_id\` VARCHAR(255),
    \`parent_id\` VARCHAR(255),
    \`slug\` VARCHAR(255) NOT NULL,
    \`directory\` TEXT NOT NULL,
    \`path\` TEXT,
    \`title\` TEXT NOT NULL,
    \`version\` VARCHAR(50) NOT NULL,
    \`branch\` VARCHAR(256),
    \`share_url\` TEXT,
    \`summary_additions\` INT,
    \`summary_deletions\` INT,
    \`summary_files\` INT,
    \`summary_diffs\` JSON,
    \`revert\` JSON,
    \`permission\` JSON,
    \`agent\` TEXT,
    \`model\` JSON,
    \`time_created\` BIGINT NOT NULL,
    \`time_updated\` BIGINT NOT NULL,
    \`time_compacting\` BIGINT,
    \`time_archived\` BIGINT,
    PRIMARY KEY (\`id\`),
    INDEX \`session_project_idx\` (\`project_id\`),
    INDEX \`session_workspace_idx\` (\`workspace_id\`),
    INDEX \`session_parent_idx\` (\`parent_id\`),
    FOREIGN KEY (\`project_id\`) REFERENCES \`project\` (\`id\`) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS \`workspace\` (
    \`id\` VARCHAR(255) NOT NULL,
    \`type\` VARCHAR(100) NOT NULL,
    \`name\` TEXT NOT NULL DEFAULT '',
    \`branch\` TEXT,
    \`directory\` TEXT,
    \`extra\` JSON,
    \`project_id\` VARCHAR(255) NOT NULL,
    PRIMARY KEY (\`id\`),
    FOREIGN KEY (\`project_id\`) REFERENCES \`project\` (\`id\`) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS \`permission\` (
    \`project_id\` VARCHAR(255) NOT NULL,
    \`time_created\` BIGINT NOT NULL,
    \`time_updated\` BIGINT NOT NULL,
    \`data\` JSON NOT NULL,
    PRIMARY KEY (\`project_id\`),
    FOREIGN KEY (\`project_id\`) REFERENCES \`project\` (\`id\`) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS \`message\` (
    \`id\` VARCHAR(255) NOT NULL,
    \`session_id\` VARCHAR(255) NOT NULL,
    \`time_created\` BIGINT NOT NULL,
    \`time_updated\` BIGINT NOT NULL,
    \`data\` JSON NOT NULL,
    PRIMARY KEY (\`id\`),
    INDEX \`message_session_time_created_id_idx\` (\`session_id\`, \`time_created\`, \`id\`),
    FOREIGN KEY (\`session_id\`) REFERENCES \`session\` (\`id\`) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS \`session_message\` (
    \`id\` VARCHAR(255) NOT NULL,
    \`session_id\` VARCHAR(255) NOT NULL,
    \`type\` VARCHAR(100) NOT NULL,
    \`time_created\` BIGINT NOT NULL,
    \`time_updated\` BIGINT NOT NULL,
    \`data\` JSON NOT NULL,
    PRIMARY KEY (\`id\`),
    INDEX \`session_message_session_idx\` (\`session_id\`),
    INDEX \`session_message_session_type_idx\` (\`session_id\`, \`type\`),
    INDEX \`session_message_time_created_idx\` (\`time_created\`),
    FOREIGN KEY (\`session_id\`) REFERENCES \`session\` (\`id\`) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS \`todo\` (
    \`session_id\` VARCHAR(255) NOT NULL,
    \`content\` TEXT NOT NULL,
    \`status\` VARCHAR(50) NOT NULL,
    \`priority\` VARCHAR(50) NOT NULL,
    \`position\` INT NOT NULL,
    \`time_created\` BIGINT NOT NULL,
    \`time_updated\` BIGINT NOT NULL,
    PRIMARY KEY (\`session_id\`, \`position\`),
    INDEX \`todo_session_idx\` (\`session_id\`),
    FOREIGN KEY (\`session_id\`) REFERENCES \`session\` (\`id\`) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS \`session_share\` (
    \`session_id\` VARCHAR(255) NOT NULL,
    \`id\` VARCHAR(255) NOT NULL,
    \`secret\` TEXT NOT NULL,
    \`url\` TEXT NOT NULL,
    \`time_created\` BIGINT NOT NULL,
    \`time_updated\` BIGINT NOT NULL,
    PRIMARY KEY (\`session_id\`),
    FOREIGN KEY (\`session_id\`) REFERENCES \`session\` (\`id\`) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS \`part\` (
    \`id\` VARCHAR(255) NOT NULL,
    \`message_id\` VARCHAR(255) NOT NULL,
    \`session_id\` VARCHAR(255) NOT NULL,
    \`time_created\` BIGINT NOT NULL,
    \`time_updated\` BIGINT NOT NULL,
    \`data\` JSON NOT NULL,
    PRIMARY KEY (\`id\`),
    INDEX \`part_message_id_id_idx\` (\`message_id\`, \`id\`),
    INDEX \`part_session_idx\` (\`session_id\`),
    FOREIGN KEY (\`message_id\`) REFERENCES \`message\` (\`id\`) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS \`event\` (
    \`id\` VARCHAR(255) NOT NULL,
    \`aggregate_id\` VARCHAR(255) NOT NULL,
    \`seq\` INT NOT NULL,
    \`type\` VARCHAR(255) NOT NULL,
    \`data\` JSON NOT NULL,
    PRIMARY KEY (\`id\`),
    FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\` (\`aggregate_id\`) ON DELETE CASCADE
  )`,
]

// ── SQLite-compatible proxy ───────────────────────────────────────────────────
// Wraps MySQL drizzle query builders so they present the same .get()/.all()/.run()
// termination API as the SQLite drizzle adapter. This lets all query code in the
// codebase stay SQLite-shaped while actually running against MySQL at runtime.

function isProtocolError(err: unknown): boolean {
  const messages = errorMessages(err).join("\n")
  return /packets? out of order|PROTOCOL_PACKETS_OUT_OF_ORDER|packet sequence|PROTOCOL_CONNECTION_LOST|ECONNRESET|EPIPE|fatal error|closed state|connection is closed/i.test(messages)
}

function errorMessages(err: unknown, seen = new Set<unknown>()): string[] {
  if (typeof err !== "object" || err === null || seen.has(err)) return [String(err)]
  seen.add(err)
  const record = err as Record<string, unknown>
  return [record.code, record.errno, record.sqlState, record.sqlMessage, record.message, ...errorMessages(record.cause, seen)]
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .map(String)
}

function wrapQueryBuilder(target: any, onError: (err: unknown) => Promise<void>): any {
  if (target === null || target === undefined || typeof target !== "object") return target

  return new Proxy(target, {
    get(t, prop: string | symbol) {
      // SQLite termination methods that MySQL doesn't have ─────────────────────
      if (prop === "get") {
        return async () => {
          const rows = await Promise.resolve(t).catch(async (err) => {
            await onError(err)
            throw err
          })
          return Array.isArray(rows) ? rows[0] : undefined
        }
      }
      if (prop === "all") {
        return async () => {
          const rows = await Promise.resolve(t).catch(async (err) => {
            await onError(err)
            throw err
          })
          return Array.isArray(rows) ? rows : []
        }
      }
      if (prop === "run") {
        return async () => {
          await Promise.resolve(t).catch(async (err) => {
            await onError(err)
            throw err
          })
        }
      }
      // SQLite's RETURNING clause ─ MySQL doesn't support it as a chained
      // method. We return the same proxy so .get()/.all() still work on the
      // DML result. Callers that need the actual row must do a follow-up SELECT.
      if (prop === "returning") {
        return () => wrapQueryBuilder(t, onError)
      }
      // SQLite conflict helpers → MySQL equivalents ────────────────────────────
      if (prop === "onConflictDoUpdate") {
        return (config: { target?: unknown; set: Record<string, unknown> }) =>
          wrapQueryBuilder(t.onDuplicateKeyUpdate({ set: config.set }), onError)
      }
      if (prop === "onConflictDoNothing") {
        return () => {
          const cfg = t.config
          if (cfg) cfg.ignore = true
          return wrapQueryBuilder(t, onError)
        }
      }

      // Pass Promise protocol through unwrapped to prevent infinite recursion
      // when the proxy is awaited (await proxy → proxy.then(resolve, reject)).
      if (prop === "then") {
        return (resolve: unknown, reject: unknown) =>
          Promise.resolve(t)
            .catch(async (err) => {
              await onError(err)
              throw err
            })
            .then(resolve as never, reject as never)
      }
      if (prop === "catch") {
        return (reject: unknown) =>
          Promise.resolve(t)
            .catch(async (err) => {
              await onError(err)
              throw err
            })
            .catch(reject as never)
      }
      if (prop === "finally") {
        return (fn: unknown) =>
          Promise.resolve(t)
            .catch(async (err) => {
              await onError(err)
              throw err
            })
            .finally(fn as never)
      }

      // Delegate everything else, wrapping returned query builders ─────────────
      const val = t[prop]
      if (typeof val === "function") {
        return (...args: unknown[]) => {
          const result = val.apply(t, args)
          if (
            result !== null &&
            result !== undefined &&
            typeof result === "object" &&
            typeof (result as any).execute === "function"
          ) {
            return wrapQueryBuilder(result, onError)
          }
          return result
        }
      }
      return val
    },
  })
}

function wrapMySqlDb(getDb: () => MySql2Database, onError: (err: unknown) => Promise<void>): DB {
  return new Proxy({} as DB, {
    get(_target, prop: string | symbol) {
      const val = (getDb() as any)[prop]
      if (typeof val === "function") {
        return (...args: unknown[]) => {
          const db = getDb()
          const result = val.apply(db, args)
          if (result !== null && result !== undefined && typeof result === "object") {
            return wrapQueryBuilder(result, onError)
          }
          return result
        }
      }
      return val
    },
  })
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export function computePath(connectionString: string): string {
  return connectionString
}

function parseConnectionString(url: string): mysql.ConnectionOptions {
  const parsed = new URL(url)
  return {
    host: parsed.hostname || "127.0.0.1",
    port: parseInt(parsed.port || "3306"),
    user: parsed.username || undefined,
    password: parsed.password || undefined,
    database: parsed.pathname.replace(/^\//, "") || undefined,
  }
}

export function init(connectionString: string): StorageAdapter {
  const options = parseConnectionString(connectionString)
  let connection: Connection | undefined
  let mysqlDb: MySql2Database | undefined
  let connecting: Promise<MySql2Database> | undefined
  let closed = false

  const connect = async (): Promise<MySql2Database> => {
    if (mysqlDb) return mysqlDb
    if (connecting) return connecting
    if (closed) throw new Error("Database connection is closed")
    connecting = mysql.createConnection(options).then((conn) => {
      connection = conn
      mysqlDb = drizzle({ client: conn, logger: drizzleLogger }) as MySql2Database
      return mysqlDb
    }).finally(() => {
      connecting = undefined
    })
    return connecting
  }

  const currentDb = (): MySql2Database => {
    if (!mysqlDb) throw new Error("Database connection is not ready")
    return mysqlDb
  }

  const reconnect = async (err: unknown): Promise<void> => {
    if (!isProtocolError(err) || closed) return
    log.warn("reconnecting mysql connection after protocol error", { error: err })
    const old = connection
    connection = undefined
    mysqlDb = undefined
    old?.destroy()
    await connect()
  }

  const execute = async <T>(statement: Parameters<MySql2Database["execute"]>[0]): Promise<T> => {
    try {
      return (await (await connect()).execute(statement)) as T
    } catch (err) {
      await reconnect(err)
      throw err
    }
  }

  const hasCommitInHistory = async (branch: string, commit: string): Promise<boolean> => {
    const [rows] = await execute<[unknown, unknown]>(
      sql`SELECT count(*) FROM dolt_log AS OF ${branch} WHERE commit_hash = ${commit}`,
    )
    const row = (rows as unknown as Record<string, unknown>[])[0]
    return Number(Object.values(row)[0]) > 0
  }

  return {
    db: wrapMySqlDb(currentDb, reconnect),
    mysqlDb: wrapMySqlDb(currentDb, reconnect),
    path: connectionString,
    migrate: async () => {
      for (const sql of DDL) {
        await execute(sql)
        log.info("query", { sql })
      }
    },
    close: async () => {
      closed = true
      const conn = connection
      connection = undefined
      mysqlDb = undefined
      await conn?.end().catch(() => conn.destroy())
    },
    currentBranch: async (): Promise<string> => {
      const [rows] = await execute<[unknown, unknown]>(sql`SELECT active_branch()`)
      const row = (rows as unknown as Record<string, unknown>[])[0]
      return Object.values(row)[0] as string
    },
    changeBranch: async (name: string): Promise<void> => {
      await execute(sql`CALL dolt_checkout(${name})`)
    },
    createBranch: async (name: string, startPoint: string | null, force: boolean): Promise<void> => {
      if (!name) throw new Error("branch name must be non-empty")
      if (startPoint && force) {
        await execute(sql`CALL dolt_branch('-f', ${name}, ${startPoint})`)
      } else if (startPoint) {
        await execute(sql`CALL dolt_branch(${name}, ${startPoint})`)
      } else if (force) {
        await execute(sql`CALL dolt_branch('-f', ${name})`)
      } else {
        await execute(sql`CALL dolt_branch(${name})`)
      }
    },
    checkoutNew: async (name: string, force: boolean = false): Promise<void> => {
      if (!name) throw new Error("branch name must be non-empty")
      const flag = force ? "-B" : "-b"
      await execute(sql`CALL dolt_checkout(${flag}, ${name})`)
    },
    hasBranch: async (name: string): Promise<boolean> => {
      const [rows] = await execute<[unknown, unknown]>(sql`SELECT count(*) FROM dolt_branches WHERE name = ${name}`)
      const row = (rows as unknown as Record<string, unknown>[])[0]
      return Number(Object.values(row)[0]) > 0
    },
    branchHash: async (branch: string): Promise<string> => {
      const [rows] = await execute<[unknown, unknown]>(sql`SELECT hashof(${branch})`)
      const row = (rows as unknown as Record<string, unknown>[])[0]
      const value = row ? Object.values(row)[0] : undefined
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Could not resolve hash for branch "${branch}"`)
      }
      return value
    },
    hasCommitInHistory,
    listBranchesWithBase: async (baseBranch: string) => {
      const [rows] = await execute<[unknown, unknown]>(
        sql`SELECT name, hash, latest_commit_message FROM dolt_branches`,
      )
      const branches = rows as unknown as Array<{ name: string; hash: string; latest_commit_message: string }>
      const base = branches.find((b) => b.name === baseBranch)
      if (!base) {
        throw new Error(`Base branch "${baseBranch}" not found in dolt_branches`)
      }
      const result: Array<{ name: string; commitHash: string; commitMessage: string }> = []
      for (const b of branches) {
        if (b.name === baseBranch) continue
        if (await hasCommitInHistory(b.name, base.hash)) {
          result.push({ name: b.name, commitHash: b.hash, commitMessage: b.latest_commit_message })
        }
      }
      return result
    },
    diffStat: async (param1: string, param2: string) => {
      // Tables that hold session-context state. Mirrors what the LLM-context
      // builder reads from.
      const tables = ["message", "part", "todo"]
      // Tables whose payload size we care about (they have a `data` JSON
      // column). Other tables get zeros for the byte fields.
      const tablesWithData = new Set(["message", "part"])
      const results: Array<{
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
        oldDataBytes: number
        newDataBytes: number
        dataBytesAdded: number
        dataBytesDeleted: number
        dataBytesModifiedDelta: number
      }> = []
      for (const table of tables) {
        try {
          const [rows] = await execute<[unknown, unknown]>(
            sql`SELECT * FROM DOLT_DIFF_STAT(${param1}, ${param2}, ${table})`,
          )
          const arr = rows as unknown as Array<Record<string, unknown>>
          if (arr.length === 0) continue
          // Compute byte-size aggregates for the `data` column from DOLT_DIFF
          // for tables that have one. Conditional sums let us cover all four
          // change shapes (added / deleted / modified / unmodified) in a
          // single SQL roundtrip.
          let dataAgg = {
            oldDataBytes: 0,
            newDataBytes: 0,
            dataBytesAdded: 0,
            dataBytesDeleted: 0,
            dataBytesModifiedDelta: 0,
          }
          if (tablesWithData.has(table)) {
            const [aggRows] = await execute<[unknown, unknown]>(
              sql`
                SELECT
                  COALESCE(SUM(LENGTH(from_data)), 0) AS old_bytes,
                  COALESCE(SUM(LENGTH(to_data)), 0) AS new_bytes,
                  COALESCE(SUM(CASE WHEN from_data IS NULL THEN LENGTH(to_data) ELSE 0 END), 0) AS bytes_added,
                  COALESCE(SUM(CASE WHEN to_data IS NULL THEN LENGTH(from_data) ELSE 0 END), 0) AS bytes_deleted,
                  COALESCE(SUM(CASE WHEN from_data IS NOT NULL AND to_data IS NOT NULL
                                    THEN LENGTH(to_data) - LENGTH(from_data) ELSE 0 END), 0) AS bytes_modified_delta
                FROM DOLT_DIFF(${param1}, ${param2}, ${table})
              `,
            )
            const aggRow = (aggRows as unknown as Array<Record<string, unknown>>)[0] ?? {}
            dataAgg = {
              oldDataBytes: Number(aggRow.old_bytes ?? 0),
              newDataBytes: Number(aggRow.new_bytes ?? 0),
              dataBytesAdded: Number(aggRow.bytes_added ?? 0),
              dataBytesDeleted: Number(aggRow.bytes_deleted ?? 0),
              dataBytesModifiedDelta: Number(aggRow.bytes_modified_delta ?? 0),
            }
          }
          for (const r of arr) {
            results.push({
              tableName: String(r.table_name ?? table),
              rowsUnmodified: Number(r.rows_unmodified ?? 0),
              rowsAdded: Number(r.rows_added ?? 0),
              rowsDeleted: Number(r.rows_deleted ?? 0),
              rowsModified: Number(r.rows_modified ?? 0),
              cellsAdded: Number(r.cells_added ?? 0),
              cellsDeleted: Number(r.cells_deleted ?? 0),
              cellsModified: Number(r.cells_modified ?? 0),
              oldRowCount: Number(r.old_row_count ?? 0),
              newRowCount: Number(r.new_row_count ?? 0),
              oldCellCount: Number(r.old_cell_count ?? 0),
              newCellCount: Number(r.new_cell_count ?? 0),
              ...dataAgg,
            })
          }
        } catch (e) {
          // Per-table errors (e.g. table dropped between refs) shouldn't tank
          // the whole call. Surface them through the unwrap path.
          throw new Error(`DOLT_DIFF_STAT(${param1}, ${param2}, ${table}): ${unwrapSqlError(e)}`)
        }
      }
      return results
    },
    executeRaw: async (statement: string) => {
      try {
        const [result] = await execute<[unknown, unknown]>(sql.raw(statement))
        if (Array.isArray(result)) {
          const rows = result as Array<Record<string, unknown>>
          const columns = rows.length > 0 ? Object.keys(rows[0]) : []
          return { kind: "rows" as const, columns, rows }
        }
        const header = result as {
          affectedRows?: number
          insertId?: number | string
          info?: string
        }
        return {
          kind: "result" as const,
          affectedRows: header.affectedRows,
          insertId: header.insertId,
          info: header.info,
        }
      } catch (e) {
        throw new Error(unwrapSqlError(e))
      }
    },
    getCommitLog: async () => {
      const [rows] = await execute<[unknown, unknown]>(
        sql`SELECT commit_hash, date, message FROM dolt_log ORDER BY commit_order desc`,
      )
      return (rows as unknown as Array<{ commit_hash: string; date: Date; message: string }>).map((row) => ({
        commitHash: row.commit_hash,
        date: row.date,
        message: row.message,
      }))
    },
    commit: async (message: string): Promise<void> => {
      try {
        await execute(sql`CALL dolt_commit('-Am', ${message})`)
      } catch (e) {
        throw new Error(unwrapSqlError(e))
      }
    },
    commitEmpty: async (message: string): Promise<void> => {
      try {
        await execute(sql`CALL dolt_commit('--allow-empty', '-m', ${message})`)
      } catch (e) {
        throw new Error(unwrapSqlError(e))
      }
    },
    isDirty: async (): Promise<boolean> => {
      const [rows] = await execute<[unknown, unknown]>(sql`SELECT count(*) FROM dolt_diff WHERE commit_hash = 'WORKING'`)
      const row = (rows as unknown as Record<string, unknown>[])[0]
      return Number(Object.values(row)[0]) !== 0
    },
    merge: async (branch: string, squash: boolean = false): Promise<void> => {
      if (squash) {
        await execute(sql`CALL dolt_merge(${branch}, '--squash')`)
      } else {
        await execute(sql`CALL dolt_merge(${branch})`)
      }
    },
    reset: async (ref: string): Promise<void> => {
      await execute(sql`CALL dolt_reset('--hard', ${ref})`)
    },
  }
}
