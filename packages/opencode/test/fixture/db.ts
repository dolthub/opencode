import { rm } from "fs/promises"
import { Database } from "@/storage/db"
import { disposeAllInstances } from "./fixture"

export async function resetDatabase() {
  await disposeAllInstances().catch(() => undefined)
  const p = Database.adapterPath()
  Database.close()
  await rm(p, { force: true }).catch(() => undefined)
  await rm(`${p}-wal`, { force: true }).catch(() => undefined)
  await rm(`${p}-shm`, { force: true }).catch(() => undefined)
}
