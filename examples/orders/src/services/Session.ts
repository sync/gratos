// The session, read in the context factory (graphql.ts, with runInRequest): the bearer token is
// a user id, which the backend must know. No token, or an unknown user, is a guest (undefined).
import { Effect, Option } from "effect";

import { Api } from "./Api.ts";

export interface Session {
  readonly userId: string;
  readonly scopes: ReadonlyArray<string>;
}

const BEARER = /^Bearer\s+(\S+)$/i;

export const Session = {
  read: (request: Request): Effect.Effect<Session | undefined, never, Api> =>
    Effect.gen(function* () {
      const token = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
      if (token === undefined) {
        return undefined;
      }
      const api = yield* Api;
      const user = yield* Effect.option(api.user_get({ id: token }));
      return Option.match(user, {
        onNone: () => undefined,
        onSome: (row): Session => ({ userId: row.id, scopes: ["USER"] }),
      });
    }).pipe(Effect.withSpan("session.read")),
};
