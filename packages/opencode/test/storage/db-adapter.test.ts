// Adapter-level read-after-write tests. These cover the opencode-on-doltlite
// regression where a session row inserted inside BEGIN IMMEDIATE / COMMIT
// became invisible to subsequent SELECTs — the original adapter triggered
// dolt_commit per write, which interacted badly with read-after-write
// semantics. This file pins down the read-after-write contract so any future
// adapter changes have to keep passing it.
import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { eq } from "drizzle-orm"
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { init } from "@/storage/db.doltlite.bun"

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-adapter-test-"))
  const dbPath = path.join(dir, "adapter.ddb")
  const db = init(dbPath)
  return { db, dir }
}

// Minimal opencode-shaped schema: project + session with FK.
const project = sqliteTable("project", {
  id: text("id").primaryKey(),
  worktree: text("worktree").notNull(),
  timeCreated: integer("time_created").notNull(),
  timeUpdated: integer("time_updated").notNull(),
  sandboxes: text("sandboxes").notNull(),
})

const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  directory: text("directory").notNull(),
  title: text("title").notNull(),
  version: text("version").notNull(),
  agent: text("agent"),
  model: text("model"),
  timeCreated: integer("time_created").notNull(),
  timeUpdated: integer("time_updated").notNull(),
})

function makeSchema(db: ReturnType<typeof init>) {
  db.$client.exec("PRAGMA foreign_keys = ON")
  db.$client.exec(`
    CREATE TABLE project (
      id text PRIMARY KEY, worktree text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL,
      sandboxes text NOT NULL
    );
    CREATE TABLE session (
      id text PRIMARY KEY, project_id text NOT NULL,
      slug text NOT NULL, directory text NOT NULL,
      title text NOT NULL, version text NOT NULL,
      agent text, model text,
      time_created integer NOT NULL, time_updated integer NOT NULL,
      FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
    );
  `)
  db.insert(project).values({
    id: "global", worktree: "/", timeCreated: 1, timeUpdated: 1, sandboxes: "[]",
  }).run()
}

describe("DoltliteClientAdapter — read-after-write", () => {
  test("autocommit insert is visible to immediate SELECT", () => {
    const { db } = freshDb()
    makeSchema(db)
    db.insert(session).values({
      id: "ses_auto", projectId: "global", slug: "s",
      directory: "/", title: "t", version: "v",
      agent: "build", model: "m", timeCreated: 1, timeUpdated: 1,
    }).run()
    const rows = db.select().from(session).where(eq(session.id, "ses_auto")).all()
    expect(rows.length).toBe(1)
  })

  test("BEGIN IMMEDIATE / INSERT / COMMIT — row visible to autocommit SELECT", () => {
    const { db } = freshDb()
    makeSchema(db)
    db.transaction((tx) => {
      tx.insert(session).values({
        id: "ses_imm", projectId: "global", slug: "s",
        directory: "/", title: "t", version: "v",
        agent: "build", model: "m", timeCreated: 1, timeUpdated: 1,
      }).run()
    }, { behavior: "immediate" })
    // Repeat the SELECT four times to mirror opencode's retry-loop in the wild.
    for (let i = 0; i < 4; i++) {
      const rows = db.select().from(session).where(eq(session.id, "ses_imm")).all()
      expect(rows.length).toBe(1)
    }
  })

  test("BEGIN DEFERRED / INSERT / COMMIT — row visible", () => {
    const { db } = freshDb()
    makeSchema(db)
    db.transaction((tx) => {
      tx.insert(session).values({
        id: "ses_def", projectId: "global", slug: "s",
        directory: "/", title: "t", version: "v",
        agent: "build", model: "m", timeCreated: 1, timeUpdated: 1,
      }).run()
    })
    const rows = db.select().from(session).where(eq(session.id, "ses_def")).all()
    expect(rows.length).toBe(1)
  })

  test("ROLLBACK throws and discards the insert", () => {
    const { db } = freshDb()
    makeSchema(db)
    expect(() =>
      db.transaction((tx) => {
        tx.insert(session).values({
          id: "ses_rb", projectId: "global", slug: "s",
          directory: "/", title: "t", version: "v",
          agent: "build", model: "m", timeCreated: 1, timeUpdated: 1,
        }).run()
        throw new Error("trigger rollback")
      }, { behavior: "immediate" })
    ).toThrow("trigger rollback")
    const rows = db.select().from(session).where(eq(session.id, "ses_rb")).all()
    expect(rows.length).toBe(0)
  })

  test("multiple sequential transactions all visible", () => {
    const { db } = freshDb()
    makeSchema(db)
    for (let i = 0; i < 5; i++) {
      db.transaction((tx) => {
        tx.insert(session).values({
          id: `ses_${i}`, projectId: "global", slug: "s",
          directory: "/", title: "t", version: "v",
          agent: "build", model: "m", timeCreated: i, timeUpdated: i,
        }).run()
      }, { behavior: "immediate" })
    }
    const all = db.select().from(session).all()
    expect(all.length).toBe(5)
    for (let i = 0; i < 5; i++) {
      const row = db.select().from(session).where(eq(session.id, `ses_${i}`)).get()
      expect(row?.id).toBe(`ses_${i}`)
    }
  })
})
