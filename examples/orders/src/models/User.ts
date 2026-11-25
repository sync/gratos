import type { ID } from "@dblechoc/gratos";
import { Effect } from "effect";

import { Api } from "../services/Api.ts";
import type { UserRow } from "../services/Api.ts";
import type { AppError } from "../services/errors.ts";
import type { Ctx, Services } from "./context.ts";

/** A user who places orders. @gqlType */
export class User {
  /** @gqlField */
  id: ID;
  /** @gqlField */
  name: string;

  constructor(row: UserRow) {
    this.id = row.id;
    this.name = row.name;
  }
}

/** A user, by id. @gqlQueryField */
export function user(ctx: Ctx, id: ID): Effect.Effect<User, AppError, Services> {
  return ctx.guard({
    scopes: ["USER"],
    effect: Effect.gen(function* () {
      const api = yield* Api;
      return new User(yield* api.user_get({ id }));
    }),
  });
}
