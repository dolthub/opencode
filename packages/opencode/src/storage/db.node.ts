import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"
import type { StorageAdapter, Journal } from "./db.adapter"

export function computePath(filePath: string): string {
  return filePath
}

export function init(filePath: string): StorageAdapter {
  const sqlite = new DatabaseSync(filePath)
  const db = drizzle({ client: sqlite as any })
  return {
    db: db as any,
    path: filePath,
    migrate: (entries: Journal) => {
      const metas = entries.map((d) => ({
        sql: d.sql.split("--> statement-breakpoint"),
        folderMillis: d.timestamp,
        hash: "",
        bps: true,
        name: d.name,
      }))
      ;(db as any).dialect.migrate(metas, (db as any).session, {})
    },
    close: () => sqlite.close(),
    doltCommit: () => {},
    supportsVersioning: () => false,
    createBranch: () => { throw new Error("not implemented") },
    changeBranch: () => { throw new Error("not implemented") },
    currentBranch: () => { throw new Error("not implemented") },
    hasBranch: () => { throw new Error("not implemented") },
  }
}
