import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance"
import { SessionID, MessageID } from "@/session/schema"
import { Effect, Layer, Context, Schema } from "effect"
import z from "zod"
import { zod, ZodOverride } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: BusEvent.define(
    "command.executed",
    Schema.Struct({
      name: Schema.String,
      sessionID: SessionID,
      arguments: Schema.String,
      messageID: MessageID,
    }),
  ),
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown.annotate({ [ZodOverride]: z.promise(z.string()).or(z.string()) }),
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
})
  .annotate({ identifier: "Command" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

// for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
  COMMIT: "commit",
  NEW: "new",
  BRANCH: "branch",
  CHECKOUT: "checkout",
  LOG: "log",
  SQL: "sql",
  CONTEXT: "context",
  DIFF_STAT: "diff-stat",
  DIFF_CONTEXT: "diff-context",
  HISTORY: "history",
  RESET: "reset",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }
      commands[Default.COMMIT] = {
        name: Default.COMMIT,
        description: "commit versioned changes with a message",
        source: "command",
        get template() {
          return ""
        },
        hints: ["$ARGUMENTS"],
      }
      commands[Default.NEW] = {
        name: Default.NEW,
        description: "create a new branch and switch the session to it",
        source: "command",
        get template() {
          return ""
        },
        hints: ["$ARGUMENTS"],
      }
      commands[Default.BRANCH] = {
        name: Default.BRANCH,
        description: "list branches; create at a ref (<name> <ref>) or at a prompt boundary (<name> [N] [-m msg])",
        source: "command",
        get template() {
          return ""
        },
        hints: ["$ARGUMENTS"],
      }
      commands[Default.CHECKOUT] = {
        name: Default.CHECKOUT,
        description: "switch the session to an existing branch",
        source: "command",
        get template() {
          return ""
        },
        hints: ["$ARGUMENTS"],
      }
      commands[Default.LOG] = {
        name: Default.LOG,
        description: "show the commit log for the current branch",
        source: "command",
        get template() {
          return ""
        },
        hints: [],
      }
      commands[Default.SQL] = {
        name: Default.SQL,
        description: "run arbitrary SQL against the storage",
        source: "command",
        get template() {
          return ""
        },
        hints: ["$ARGUMENTS"],
      }
      commands[Default.CONTEXT] = {
        name: Default.CONTEXT,
        description: "show stats about the next LLM call's context (--show to dump it)",
        source: "command",
        get template() {
          return ""
        },
        hints: ["$ARGUMENTS"],
      }
      commands[Default.DIFF_STAT] = {
        name: Default.DIFF_STAT,
        description: "show per-table diff stats between two refs (default HEAD..WORKING)",
        source: "command",
        get template() {
          return ""
        },
        hints: ["$ARGUMENTS"],
      }
      commands[Default.DIFF_CONTEXT] = {
        name: Default.DIFF_CONTEXT,
        description: "diff the LLM context between two refs (default HEAD..WORKING)",
        source: "command",
        get template() {
          return ""
        },
        hints: ["$ARGUMENTS"],
      }
      commands[Default.HISTORY] = {
        name: Default.HISTORY,
        description: "list user prompts in this session (or as of a ref)",
        source: "command",
        get template() {
          return ""
        },
        hints: ["$ARGUMENTS"],
      }
      commands[Default.RESET] = {
        name: Default.RESET,
        description: "hard-reset the active branch to a ref or to the state after prompt [N]",
        source: "command",
        get template() {
          return ""
        },
        hints: ["$ARGUMENTS"],
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            return item.content
          },
          hints: [],
        }
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    return Service.of({ get, list })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export * as Command from "."
