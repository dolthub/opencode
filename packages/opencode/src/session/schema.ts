import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/id/id"
import { zod, ZodOverride } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const SESSION_SUFFIX = "_session"

export const SessionID = Schema.String.annotate({ [ZodOverride]: z.string().endsWith(SESSION_SUFFIX) }).pipe(
  Schema.brand("SessionID"),
  withStatics((s) => ({
    forProject: (projectId: string) => s.make(`${projectId}${SESSION_SUFFIX}`),
    // Test-only: tests pre-date `forProject` and synthesize unique session
    // ids via `descending(slug)`. Production code uses `forProject`.
    descending: (id?: string) => s.make(Identifier.descending("session", id)),
    zod: zod(s),
  })),
)

export type SessionID = Schema.Schema.Type<typeof SessionID>

export const MessageID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("message") }).pipe(
  Schema.brand("MessageID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("message", id)),
    zod: zod(s),
  })),
)

export type MessageID = Schema.Schema.Type<typeof MessageID>

export const PartID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("part") }).pipe(
  Schema.brand("PartID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("part", id)),
    zod: zod(s),
  })),
)

export type PartID = Schema.Schema.Type<typeof PartID>
