import { mysqlTable, varchar, text, int, bigint, json, boolean, index, primaryKey } from "drizzle-orm/mysql-core"
import { drizzle } from "drizzle-orm/mysql2"
import { sql } from "drizzle-orm"
import type { MySql2Database } from "drizzle-orm/mysql2"
import mysql from "mysql2/promise"
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

function wrapQueryBuilder(target: any): any {
  if (target === null || target === undefined || typeof target !== "object") return target

  return new Proxy(target, {
    get(t, prop: string) {
      // SQLite termination methods that MySQL doesn't have ─────────────────────
      if (prop === "get") {
        return async () => {
          const rows = await t
          return Array.isArray(rows) ? rows[0] : undefined
        }
      }
      if (prop === "all") {
        return async () => {
          const rows = await t
          return Array.isArray(rows) ? rows : []
        }
      }
      if (prop === "run") {
        return async () => {
          await t
        }
      }
      // SQLite's RETURNING clause ─ MySQL doesn't support it as a chained
      // method. We return the same proxy so .get()/.all() still work on the
      // DML result. Callers that need the actual row must do a follow-up SELECT.
      if (prop === "returning") {
        return () => wrapQueryBuilder(t)
      }
      // SQLite conflict helpers → MySQL equivalents ────────────────────────────
      if (prop === "onConflictDoUpdate") {
        return (config: { target?: unknown; set: Record<string, unknown> }) =>
          wrapQueryBuilder(t.onDuplicateKeyUpdate({ set: config.set }))
      }
      if (prop === "onConflictDoNothing") {
        return () => wrapQueryBuilder(t.ignore())
      }

      // Pass Promise protocol through unwrapped to prevent infinite recursion
      // when the proxy is awaited (await proxy → proxy.then(resolve, reject)).
      if (prop === "then" || prop === "catch" || prop === "finally") {
        const val = t[prop]
        return typeof val === "function" ? val.bind(t) : val
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
            return wrapQueryBuilder(result)
          }
          return result
        }
      }
      return val
    },
  })
}

function wrapMySqlDb(mysqlDb: MySql2Database): DB {
  return new Proxy(mysqlDb as unknown as DB, {
    get(target, prop: string) {
      const val = (mysqlDb as any)[prop]
      if (typeof val === "function") {
        return (...args: unknown[]) => {
          const result = val.apply(mysqlDb, args)
          if (result !== null && result !== undefined && typeof result === "object") {
            return wrapQueryBuilder(result)
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

function parseConnectionString(url: string): mysql.PoolOptions {
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
  const pool = mysql.createPool(parseConnectionString(connectionString))
  const mysqlDb = drizzle({ client: pool, logger: drizzleLogger }) as MySql2Database

  return {
    db: wrapMySqlDb(mysqlDb),
    mysqlDb,
    path: connectionString,
    migrate: async () => {
      const conn = await pool.getConnection()
      try {
        for (const sql of DDL) {
          await conn.execute(sql)
          log.info("query", { sql })
        }
      } finally {
        conn.release()
      }
    },
    close: () => pool.end(),
    supportsVersioning: () => true,
    currentBranch: async (): Promise<string> => {
      const [rows] = await mysqlDb.execute(sql`SELECT active_branch()`)
      const row = (rows as unknown as Record<string, unknown>[])[0]
      return Object.values(row)[0] as string
    },
    changeBranch: async (name: string): Promise<void> => {
      await mysqlDb.execute(sql`CALL dolt_checkout(${name})`)
    },
    createBranch: async (name: string, startPoint: string | null, force: boolean): Promise<void> => {
      if (!name) throw new Error("branch name must be non-empty")
      if (startPoint && force) {
        await mysqlDb.execute(sql`CALL dolt_branch('-f', ${name}, ${startPoint})`)
      } else if (startPoint) {
        await mysqlDb.execute(sql`CALL dolt_branch(${name}, ${startPoint})`)
      } else if (force) {
        await mysqlDb.execute(sql`CALL dolt_branch('-f', ${name})`)
      } else {
        await mysqlDb.execute(sql`CALL dolt_branch(${name})`)
      }
    },
    hasBranch: async (name: string): Promise<boolean> => {
      const [rows] = await mysqlDb.execute(sql`SELECT count(*) FROM dolt_branches WHERE name = ${name}`)
      const row = (rows as unknown as Record<string, unknown>[])[0]
      return Number(Object.values(row)[0]) > 0
    },
    doltCommit: async (message: string): Promise<void> => {
      try {
        await mysqlDb.execute(sql`CALL dolt_commit('-Am', ${message})`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!msg.toLowerCase().includes("nothing to commit")) {
          log.warn("dolt_commit failed", { error: msg })
        }
      }
    },
  }
}
