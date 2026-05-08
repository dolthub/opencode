import { DatabaseSync } from "@dolthub/doltlite"
import { drizzle } from "drizzle-orm/node-sqlite"

export function init(path: string) {
  const sqlite = new DatabaseSync(path)
  const db = drizzle({ client: sqlite as any })
  ;(db as any).$client = sqlite
  return db
}
