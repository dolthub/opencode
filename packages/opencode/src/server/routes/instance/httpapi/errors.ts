import { Schema } from "effect"

export class ApiNotFoundError extends Schema.ErrorClass<ApiNotFoundError>("NotFoundError")(
  {
    name: Schema.Literal("NotFoundError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export function notFound(message: string) {
  return new ApiNotFoundError({
    name: "NotFoundError",
    data: { message },
  })
}

export class ApiCommitError extends Schema.ErrorClass<ApiCommitError>("CommitError")(
  {
    name: Schema.Literal("CommitError"),
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export function commitError(message: string) {
  return new ApiCommitError({ name: "CommitError", message })
}
