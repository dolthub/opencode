import { and, desc, eq } from "@/storage/db"
import { Database } from "@/storage/db"
import { SessionMessage } from "@/v2/session-message"
import { SessionMessageUpdater } from "@/v2/session-message-updater"
import { SessionEvent } from "@/v2/session-event"
import * as DateTime from "effect/DateTime"
import { SyncEvent } from "@/sync"
import { SessionMessageTable, SessionTable } from "./session.sql"
import type { SessionID } from "./schema"
import { Schema } from "effect"

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
type SessionMessageData = NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>

function encodeDateTimes(value: unknown): unknown {
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value)
  if (Array.isArray(value)) return value.map(encodeDateTimes)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeDateTimes(item)]))
  }
  return value
}

function encodeMessageData(value: unknown): SessionMessageData {
  return encodeDateTimes(value) as SessionMessageData
}

function sqlite(db: Database.TxOrDb, sessionID: SessionID): SessionMessageUpdater.Adapter<void> {
  return {
    getCurrentAssistant() {
      return db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant")))
        .orderBy(desc(SessionMessageTable.id))
        .all()
        .map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
        .find((message): message is SessionMessage.Assistant => message.type === "assistant" && !message.time.completed)
    },
    getCurrentCompaction() {
      return db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
        .orderBy(desc(SessionMessageTable.id))
        .all()
        .map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
        .find((message): message is SessionMessage.Compaction => message.type === "compaction")
    },
    getCurrentShell(callID) {
      return db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "shell")))
        .orderBy(desc(SessionMessageTable.id))
        .all()
        .map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
        .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
    },
    updateAssistant(assistant) {
      const { id, type, ...data } = assistant
      db.update(SessionMessageTable)
        .set({ data: encodeMessageData(data) })
        .where(
          and(
            eq(SessionMessageTable.id, id),
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, type),
          ),
        )
        .run()
    },
    updateCompaction(compaction) {
      const { id, type, ...data } = compaction
      db.update(SessionMessageTable)
        .set({ data: encodeMessageData(data) })
        .where(
          and(
            eq(SessionMessageTable.id, id),
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, type),
          ),
        )
        .run()
    },
    updateShell(shell) {
      const { id, type, ...data } = shell
      db.update(SessionMessageTable)
        .set({ data: encodeMessageData(data) })
        .where(
          and(
            eq(SessionMessageTable.id, id),
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, type),
          ),
        )
        .run()
    },
    appendMessage(message) {
      const { id, type, ...data } = message
      db.insert(SessionMessageTable)
        .values([
          {
            id,
            session_id: sessionID,
            type,
            time_created: DateTime.toEpochMillis(message.time.created),
            data: encodeMessageData(data),
          },
        ])
        .run()
    },
    finish() {},
  }
}

async function mysqlUpdate(db: Database.AnyDB, sessionID: SessionID, event: SessionEvent.Event) {
  // Pre-fetch the messages we'll need for current state lookups
  const rows = await db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID)))
    .orderBy(desc(SessionMessageTable.id))
    .all() as (typeof SessionMessageTable.$inferSelect)[]

  const allMessages = rows.map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type }))

  type PendingWrite = () => unknown
  const pendingWrites: PendingWrite[] = []

  const adapter: SessionMessageUpdater.Adapter<void> = {
    getCurrentAssistant() {
      return allMessages.find(
        (m): m is SessionMessage.Assistant => m.type === "assistant" && !m.time.completed,
      )
    },
    getCurrentCompaction() {
      return allMessages.find((m): m is SessionMessage.Compaction => m.type === "compaction")
    },
    getCurrentShell(callID) {
      return allMessages.find(
        (m): m is SessionMessage.Shell => m.type === "shell" && m.callID === callID,
      )
    },
    updateAssistant(assistant) {
      const { id, type, ...data } = assistant
      pendingWrites.push(() =>
        db
          .update(SessionMessageTable)
          .set({ data: encodeMessageData(data) })
          .where(
            and(
              eq(SessionMessageTable.id, id),
              eq(SessionMessageTable.session_id, sessionID),
              eq(SessionMessageTable.type, type),
            ),
          )
          .run(),
      )
    },
    updateCompaction(compaction) {
      const { id, type, ...data } = compaction
      pendingWrites.push(() =>
        db
          .update(SessionMessageTable)
          .set({ data: encodeMessageData(data) })
          .where(
            and(
              eq(SessionMessageTable.id, id),
              eq(SessionMessageTable.session_id, sessionID),
              eq(SessionMessageTable.type, type),
            ),
          )
          .run(),
      )
    },
    updateShell(shell) {
      const { id, type, ...data } = shell
      pendingWrites.push(() =>
        db
          .update(SessionMessageTable)
          .set({ data: encodeMessageData(data) })
          .where(
            and(
              eq(SessionMessageTable.id, id),
              eq(SessionMessageTable.session_id, sessionID),
              eq(SessionMessageTable.type, type),
            ),
          )
          .run(),
      )
    },
    appendMessage(message) {
      const { id, type, ...data } = message
      pendingWrites.push(() =>
        db
          .insert(SessionMessageTable)
          .values([
            {
              id,
              session_id: sessionID,
              type,
              time_created: DateTime.toEpochMillis(message.time.created),
              data: encodeMessageData(data),
            },
          ])
          .run(),
      )
    },
    finish() {},
  }

  SessionMessageUpdater.update(adapter, event)

  for (const write of pendingWrites) {
    await write()
  }
}

async function update(db: Database.AnyDB, event: SessionEvent.Event) {
  const sessionID = (event.data as { sessionID: SessionID }).sessionID
  if (Database.isAsync) {
    await mysqlUpdate(db, sessionID, event)
  } else {
    SessionMessageUpdater.update(sqlite(db as Database.TxOrDb, sessionID), event)
  }
}

export default [
  SyncEvent.project(SessionEvent.AgentSwitched.Sync, async (db, data, event) => {
    await db
      .update(SessionTable)
      .set({
        agent: data.agent,
        time_updated: DateTime.toEpochMillis(data.timestamp),
      })
      .where(eq(SessionTable.id, data.sessionID))
      .run()
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.agent.switched", data })
  }),
  SyncEvent.project(SessionEvent.ModelSwitched.Sync, async (db, data, event) => {
    await db
      .update(SessionTable)
      .set({
        model: data.model,
        time_updated: DateTime.toEpochMillis(data.timestamp),
      })
      .where(eq(SessionTable.id, data.sessionID))
      .run()
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.model.switched", data })
  }),
  SyncEvent.project(SessionEvent.Prompted.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.prompted", data })
  }),
  SyncEvent.project(SessionEvent.Synthetic.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.synthetic", data })
  }),
  SyncEvent.project(SessionEvent.Shell.Started.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.shell.started", data })
  }),
  SyncEvent.project(SessionEvent.Shell.Ended.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.shell.ended", data })
  }),
  SyncEvent.project(SessionEvent.Step.Started.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.step.started", data })
  }),
  SyncEvent.project(SessionEvent.Step.Ended.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.step.ended", data })
  }),
  SyncEvent.project(SessionEvent.Step.Failed.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.step.failed", data })
  }),
  SyncEvent.project(SessionEvent.Text.Started.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.text.started", data })
  }),
  SyncEvent.project(SessionEvent.Text.Delta.Sync, () => {}),
  SyncEvent.project(SessionEvent.Text.Ended.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.text.ended", data })
  }),
  SyncEvent.project(SessionEvent.Tool.Input.Started.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.input.started", data })
  }),
  SyncEvent.project(SessionEvent.Tool.Input.Delta.Sync, () => {}),
  SyncEvent.project(SessionEvent.Tool.Input.Ended.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.input.ended", data })
  }),
  SyncEvent.project(SessionEvent.Tool.Called.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.called", data })
  }),
  SyncEvent.project(SessionEvent.Tool.Success.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.success", data })
  }),
  SyncEvent.project(SessionEvent.Tool.Failed.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.tool.failed", data })
  }),
  SyncEvent.project(SessionEvent.Reasoning.Started.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.reasoning.started", data })
  }),
  SyncEvent.project(SessionEvent.Reasoning.Delta.Sync, () => {}),
  SyncEvent.project(SessionEvent.Reasoning.Ended.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.reasoning.ended", data })
  }),
  SyncEvent.project(SessionEvent.Retried.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.retried", data })
  }),
  SyncEvent.project(SessionEvent.Compaction.Started.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.compaction.started", data })
  }),
  SyncEvent.project(SessionEvent.Compaction.Delta.Sync, () => {}),
  SyncEvent.project(SessionEvent.Compaction.Ended.Sync, async (db, data, event) => {
    await update(db, { id: SessionMessage.ID.make(event.id), type: "session.next.compaction.ended", data })
  }),
]
