import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import type { StorageAdapter, Journal } from "./db.adapter"

export function init(filePath: string): StorageAdapter {
  const sqlite = new Database(filePath, { create: true })
  const db = drizzle({ client: sqlite })
  return {
    db,
    path: filePath,
    migrate: (entries: Journal) => migrate(db, entries),
    close: () => sqlite.close(),
  }
}
