import * as Log from "@opencode-ai/core/util/log"
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
import { Database } from "@/storage/db"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"

const log = Log.create({ service: "split" })

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
export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & {
  template: Promise<string> | string
  // When present, called instead of template resolution. Receives parsed argument
  // tokens and the raw argument string; returns the final prompt string or throws
  // a user-visible Error to abort execution.
  execute?: (args: string[], rawArguments: string, sessionID: string) => Promise<string>
  // When present, called with the LLM's response text after execution completes.
  afterExecute?: (response: string, sessionID: string) => Promise<void>
}

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
  SPLIT: "split",
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
      commands[Default.SPLIT] = {
        name: Default.SPLIT,
        description: "split a task into N parallel subtasks: /split <N> <prompt>",
        source: "command",
        template: "",
        hints: [],
        execute: async (args: string[], rawArguments: string, sessionID: string): Promise<string> => {
          const count = Number(args[0])
          if (!args[0] || !Number.isInteger(count) || count < 1) {
            throw new Error("split: first argument must be a positive integer (e.g. /split 3 <prompt>)")
          }
          const promptText = args.slice(1).join(" ").trim()
          if (!promptText) {
            throw new Error("split: a prompt is required after the count (e.g. /split 3 <prompt>)")
          }

          const uuids = Array.from({ length: count }, () => crypto.randomUUID())
          const procs = await Promise.all(
            uuids.map(async (id) => {
              await Database.createBranch(id)
              const argv = ["opencode", "run", "--dolt", "--session", sessionID, "--branch", id, "--prompt", promptText]
              const proc = Bun.spawn(argv, {
                stdout: "pipe",
                stderr: "pipe",
                env: process.env,
                cwd: process.cwd(),
              })
              return { id, argv, proc }
            }),
          )

          const branches: Record<string, { argv: string[]; exit_code: number; stdout: string; stderr: string }> = {}
          await Promise.all(
            procs.map(async ({ id, argv, proc }) => {
              const [stdout, stderr, exit_code] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
              ])
              branches[id] = { argv, exit_code, stdout, stderr }
            }),
          )

          process.stderr.write(JSON.stringify({ branches }, null, 2) + "\n")

          const options: Record<string, string> = {}
          for (const [id, result] of Object.entries(branches)) {
            options[id] = result.stdout
          }

          return `Given a prompt:
  ${promptText}

And the following options:
  ${JSON.stringify(options, null, 2)}

What is the UUID of the best answer. Respond in the format \`{"uuid":<UUID>, "reason":<REASON>}\``
        },
        afterExecute: async (response: string): Promise<void> => {
          if (!Database.supportsVersioning()) return
          const match = response.match(/\{\s*"uuid"\s*:\s*"([^"]+)"/)
          if (!match) {
            process.stderr.write("split: could not parse UUID from LLM response: " + response + "\n")
            return
          }
          const uuid = match[1]
          process.stderr.write("split: resetting to branch " + uuid + "\n")
          await Effect.runPromise(Database.doltReset(uuid))
        },
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
