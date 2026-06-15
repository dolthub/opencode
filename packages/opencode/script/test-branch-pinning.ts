// Integration test for Dolt branch pinning (src/storage/db.ts).
//
// The bug this guards against: Dolt's active branch is ambient state on a single
// shared connection, so a concurrent op that flips the branch can land a
// session's writes/reads on the wrong branch, splitting and "losing" them.
//
// This script stands up its own `dolt sql-server`, points the real Database
// adapter at it, and proves: (a) the failure mode (a read on the wrong active
// branch can't see a row), (b) that pinning fixes the read, (c) that concurrent
// writes pinned to different branches never cross-contaminate, and (d) that the
// useEffect/CurrentBranch path (used by real session writes) pins correctly.
//
// It is a standalone script rather than a bun test because the test preload
// initializes the Database harness against an in-memory sqlite DB, which would
// race a self-hosted MySQL server. Run it directly:
//
//   bun run script/test-branch-pinning.ts
//
// Requires the `dolt` binary on PATH. Exits non-zero on any failed assertion.

import { spawn, execSync, type ChildProcess } from "child_process"
import { mkdtempSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import net from "net"
import { sql } from "drizzle-orm"
import { Effect } from "effect"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

async function waitReady(port: number, db: string) {
  const mysql = (await import("mysql2/promise")).default
  for (let i = 0; i < 60; i++) {
    try {
      const c = await mysql.createConnection({ host: "127.0.0.1", port, user: "root", database: db })
      await c.query("SELECT 1")
      await c.end()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error("dolt sql-server did not become ready")
}

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}`)
    failures++
  }
}

async function main() {
  try {
    execSync("dolt version", { stdio: "ignore" })
  } catch {
    console.log("SKIP: `dolt` binary not found on PATH")
    return
  }

  const db = "pintest"
  const port = await freePort()
  const dataDir = mkdtempSync(path.join(tmpdir(), "ocpin-"))
  const dbDir = path.join(dataDir, db)
  mkdirSync(dbDir)
  execSync("dolt init", { cwd: dbDir })

  // Must be set before the Database module is first imported (the adapter is
  // selected from this flag at module-load time).
  process.env.OPENCODE_MYSQL_URL = `mysql://root@127.0.0.1:${port}/${db}`

  let server: ChildProcess | undefined
  try {
    server = spawn("dolt", ["sql-server", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: dataDir,
      stdio: "ignore",
    })
    await waitReady(port, db)

    const { Database } = await import("@/storage/db")

    // ── helpers bound to the real Database API ──────────────────────────────
    const runPinned = (branch: string, statement: string) =>
      Database.withBranchAsync(branch, () => Database.useAsync((d) => (d as any).execute(sql.raw(statement))))

    const pinnedCount = (branch: string, id: string) =>
      Database.withBranchAsync(branch, () =>
        Database.useAsync(async (d) => {
          const res: any = await (d as any).execute(sql.raw(`SELECT COUNT(*) AS c FROM pintest WHERE id = '${id}'`))
          const rows = Array.isArray(res) ? res[0] : (res.rows ?? res)
          return Number(rows[0].c)
        }),
      )

    const activeCount = async (id: string) => {
      const res = await Database.executeRaw(`SELECT COUNT(*) AS c FROM pintest WHERE id = '${id}'`)
      return res.kind === "rows" ? Number((res.rows[0] as any).c) : 0
    }

    const committedIds = async (branch: string) => {
      const res = await Database.executeRaw(`SELECT id FROM pintest AS OF '${branch}'`)
      return res.kind === "rows" ? (res.rows as any[]).map((r) => String(r.id)) : []
    }

    const commitActive = (message: string) => Effect.runPromise(Database.commit(message))

    // ── setup: a table present on every branch ──────────────────────────────
    await Database.useAsync(() => 0) // finish adapter init + migrations
    await Database.executeRaw("CREATE TABLE pintest (id varchar(64) PRIMARY KEY, val varchar(64))")
    await commitActive("create pintest")
    await Database.createBranch("sess", "main", false)

    // ── (a)+(b) read pinning ────────────────────────────────────────────────
    console.log("read pinning:")
    await runPinned("sess", `INSERT INTO pintest (id, val) VALUES ('r1', 'x')`)
    await Database.changeBranch("sess")
    await commitActive("r1 on sess")
    await Database.changeBranch("main") // connection now on the "wrong" branch
    check("naive read on wrong active branch misses the row (reproduces the bug)", (await activeCount("r1")) === 0)
    check("read pinned to the session branch finds it (the fix)", (await pinnedCount("sess", "r1")) === 1)

    // ── (c) concurrent writes don't cross-contaminate ───────────────────────
    console.log("concurrent write pinning:")
    await Database.changeBranch("main")
    const ops: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++) {
      ops.push(runPinned("sess", `INSERT INTO pintest (id, val) VALUES ('s${i}', 's')`))
      ops.push(runPinned("main", `INSERT INTO pintest (id, val) VALUES ('m${i}', 'm')`))
    }
    await Promise.all(ops)
    await Database.changeBranch("sess")
    await commitActive("sess rows")
    await Database.changeBranch("main")
    await commitActive("main rows")
    const sessIds = await committedIds("sess")
    const mainIds = await committedIds("main")
    const sessClean = Array.from({ length: 10 }, (_, i) => i).every(
      (i) => sessIds.includes(`s${i}`) && !sessIds.includes(`m${i}`),
    )
    const mainClean = Array.from({ length: 10 }, (_, i) => i).every(
      (i) => mainIds.includes(`m${i}`) && !mainIds.includes(`s${i}`),
    )
    check("all 10 'sess' writes landed on sess, no 'main' writes leaked in", sessClean)
    check("all 10 'main' writes landed on main, no 'sess' writes leaked in", mainClean)

    // ── (d) useEffect / CurrentBranch path ──────────────────────────────────
    console.log("useEffect (CurrentBranch context) pinning:")
    await Database.changeBranch("main")
    await Effect.runPromise(
      Database.useEffect((d) =>
        (d as any).execute(sql.raw(`INSERT INTO pintest (id, val) VALUES ('eff1', 'e')`)),
      ).pipe(Effect.provideService(Database.CurrentBranch, "sess")),
    )
    await Database.changeBranch("sess")
    await commitActive("eff1 on sess")
    check("useEffect write pinned to sess via CurrentBranch", (await committedIds("sess")).includes("eff1"))
    await Database.changeBranch("main")
    check("useEffect write did not leak onto main", !(await committedIds("main")).includes("eff1"))

    Database.close()
  } finally {
    server?.kill("SIGKILL")
    rmSync(dataDir, { recursive: true, force: true })
  }

  console.log("")
  if (failures === 0) {
    console.log("PASS — all branch-pinning assertions held")
  } else {
    console.log(`FAIL — ${failures} assertion(s) failed`)
    process.exit(1)
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
