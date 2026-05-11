import { eq } from "drizzle-orm"
import { Effect, Layer, Option, Schema, Context } from "effect"

import { Database } from "@/storage/db"
import { AccountStateTable, AccountTable } from "./account.sql"
import { AccessToken, AccountID, AccountRepoError, Info, OrgID, RefreshToken } from "./schema"
import { normalizeServerUrl } from "./url"

export type AccountRow = (typeof AccountTable)["$inferSelect"]

const ACCOUNT_STATE_ID = 1

export interface Interface {
  readonly active: () => Effect.Effect<Option.Option<Info>, AccountRepoError>
  readonly list: () => Effect.Effect<Info[], AccountRepoError>
  readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountRepoError>
  readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountRepoError>
  readonly getRow: (accountID: AccountID) => Effect.Effect<Option.Option<AccountRow>, AccountRepoError>
  readonly persistToken: (input: {
    accountID: AccountID
    accessToken: AccessToken
    refreshToken: RefreshToken
    expiry: Option.Option<number>
  }) => Effect.Effect<void, AccountRepoError>
  readonly persistAccount: (input: {
    id: AccountID
    email: string
    url: string
    accessToken: AccessToken
    refreshToken: RefreshToken
    expiry: number
    orgID: Option.Option<OrgID>
  }) => Effect.Effect<void, AccountRepoError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AccountRepo") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownSync(Info)

    const db = <A>(fn: (d: Database.AnyDB) => A | Promise<A>) => Database.useEffect(fn)

    const setState = (d: Database.AnyDB, accountID: AccountID, orgID: Option.Option<OrgID>) => {
      const id = Option.getOrNull(orgID)
      return d
        .insert(AccountStateTable)
        .values({ id: ACCOUNT_STATE_ID, active_account_id: accountID, active_org_id: id })
        .onConflictDoUpdate({
          target: AccountStateTable.id,
          set: { active_account_id: accountID, active_org_id: id },
        })
        .run()
    }

    const active = Effect.fn("AccountRepo.active")(function* () {
      const stateRow = yield* db((d) =>
        d.select().from(AccountStateTable).where(eq(AccountStateTable.id, ACCOUNT_STATE_ID)).get(),
      )
      if (!stateRow?.active_account_id) return Option.none<Info>()
      const activeId = stateRow.active_account_id
      const account = yield* db((d) =>
        d.select().from(AccountTable).where(eq(AccountTable.id, activeId)).get(),
      )
      if (!account) return Option.none<Info>()
      return Option.some(decode({ ...account, active_org_id: stateRow.active_org_id ?? null }))
    })

    const list = Effect.fn("AccountRepo.list")(function* () {
      return yield* db(async (d) => {
        const rows = await d.select().from(AccountTable).all()
        return rows.map((row: AccountRow) => decode({ ...row, active_org_id: null }))
      })
    })

    const remove = Effect.fn("AccountRepo.remove")(function* (accountID: AccountID) {
      yield* db((d) =>
        d
          .update(AccountStateTable)
          .set({ active_account_id: null, active_org_id: null })
          .where(eq(AccountStateTable.active_account_id, accountID))
          .run(),
      )
      yield* db((d) => d.delete(AccountTable).where(eq(AccountTable.id, accountID)).run())
    })

    const use = Effect.fn("AccountRepo.use")((accountID: AccountID, orgID: Option.Option<OrgID>) =>
      db((d) => setState(d, accountID, orgID)).pipe(Effect.asVoid),
    )

    const getRow = Effect.fn("AccountRepo.getRow")((accountID: AccountID) =>
      db((d) => d.select().from(AccountTable).where(eq(AccountTable.id, accountID)).get()).pipe(
        Effect.map(Option.fromNullishOr),
      ),
    )

    const persistToken = Effect.fn("AccountRepo.persistToken")((input) =>
      db((d) =>
        d
          .update(AccountTable)
          .set({
            access_token: input.accessToken,
            refresh_token: input.refreshToken,
            token_expiry: Option.getOrNull(input.expiry),
          })
          .where(eq(AccountTable.id, input.accountID))
          .run(),
      ).pipe(Effect.asVoid),
    )

    const persistAccount = Effect.fn("AccountRepo.persistAccount")(function* (input) {
      const url = normalizeServerUrl(input.url)
      yield* db((d) =>
        d
          .insert(AccountTable)
          .values({
            id: input.id,
            email: input.email,
            url,
            access_token: input.accessToken,
            refresh_token: input.refreshToken,
            token_expiry: input.expiry,
          })
          .onConflictDoUpdate({
            target: AccountTable.id,
            set: {
              email: input.email,
              url,
              access_token: input.accessToken,
              refresh_token: input.refreshToken,
              token_expiry: input.expiry,
            },
          })
          .run(),
      )
      yield* db((d) => setState(d, input.id, input.orgID))
    })

    return Service.of({
      active,
      list,
      remove,
      use,
      getRow,
      persistToken,
      persistAccount,
    })
  }),
)

export * as AccountRepo from "./repo"
