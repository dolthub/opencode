import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@/storage/db"
import { DatabaseSync } from "@dolthub/doltlite"
import { init as initDoltlite } from "@/storage/db.doltlite.bun"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { JsonMigration } from "@/storage/json-migration"
import { EOL } from "os"
import { errorMessage } from "../../util/error"

function printRows(rows: Record<string, unknown>[], format: string) {
  if (format === "json") {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (rows.length === 0) return
  const keys = Object.keys(rows[0])
  console.log(keys.join("\t"))
  for (const row of rows) {
    console.log(keys.map((k) => row[k]).join("\t"))
  }
}

const QueryCommand = cmd({
  command: "$0 [query]",
  describe: "open an interactive doltlite shell or run a query",
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: async (args: { query?: string; format: string }) => {
    const query = args.query as string | undefined
    if (query) {
      const db = new DatabaseSync(Database.Path, { readOnly: true })
      try {
        const rows = db.prepare(query).all() as Record<string, unknown>[]
        printRows(rows, args.format)
      } catch (err) {
        UI.error(errorMessage(err))
        process.exit(1)
      } finally {
        db.close()
      }
      return
    }
    // The `doltlite` CLI is a sqlite3-style shell that ships with doltlite.
    // Same convention as before — assume it's on $PATH.
    const child = spawn("doltlite", [Database.Path], { stdio: "inherit" })
    await new Promise((resolve) => child.on("close", resolve))
  },
})

const PathCommand = cmd({
  command: "path",
  describe: "print the database path",
  handler: () => {
    console.log(Database.Path)
  },
})

const MigrateCommand = cmd({
  command: "migrate",
  describe: "migrate JSON data to SQLite (merges with existing data)",
  handler: async () => {
    const db = initDoltlite(Database.Path)
    const tty = process.stderr.isTTY
    const width = 36
    const orange = "\x1b[38;5;214m"
    const muted = "\x1b[0;2m"
    const reset = "\x1b[0m"
    let last = -1
    if (tty) process.stderr.write("\x1b[?25l")
    try {
      const stats = await JsonMigration.run(db, {
        progress: (event) => {
          const percent = Math.floor((event.current / event.total) * 100)
          if (percent === last) return
          last = percent
          if (tty) {
            const fill = Math.round((percent / 100) * width)
            const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
            process.stderr.write(
              `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.current}/${event.total}${reset} `,
            )
          } else {
            process.stderr.write(`sqlite-migration:${percent}${EOL}`)
          }
        },
      })
      if (tty) process.stderr.write("\n")
      if (tty) process.stderr.write("\x1b[?25h")
      else process.stderr.write(`sqlite-migration:done${EOL}`)
      UI.println(
        `Migration complete: ${stats.projects} projects, ${stats.sessions} sessions, ${stats.messages} messages`,
      )
      if (stats.errors.length > 0) {
        UI.println(`${stats.errors.length} errors occurred during migration`)
      }
    } catch (err) {
      if (tty) process.stderr.write("\x1b[?25h")
      UI.error(`Migration failed: ${errorMessage(err)}`)
      process.exit(1)
    } finally {
      ;(db as any).$client.close()
    }
  },
})

export const DbCommand = cmd({
  command: "db",
  describe: "database tools",
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).command(MigrateCommand).demandCommand()
  },
  handler: () => {},
})
