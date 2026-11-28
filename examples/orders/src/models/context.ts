// The request context every resolver receives, and how it is built from the session: the guard
// checks the session's scopes, and refuses with the app's own Forbidden.
import { makeGuard } from "gratos-server/effect";
import type { Guard } from "gratos-server/effect";

import type { Api } from "../services/Api.ts";
import type { Bus } from "../services/Bus.ts";
import { Forbidden } from "../services/errors.ts";
import type { AppError } from "../services/errors.ts";
import type { Session } from "../services/Session.ts";

/** The services resolvers may use: the fork context of every resolver provides them. */
export type Services = Api | Bus;

/** @gqlContext */
export interface Ctx {
  /** The signed-in user's session; undefined for a guest. */
  readonly session: Session | undefined;
  readonly guard: Guard<AppError>["guard"];
  readonly guardStream: Guard<AppError>["guardStream"];
}

/** The context of a request with `session` (a guest's when undefined). */
export const contextFor = (session: Session | undefined, headers?: Headers): Ctx => {
  const scopes = new Set(session?.scopes);
  const { guard, guardStream } = makeGuard<AppError>({
    authorize: (required) => required.scopes.every((scope) => scopes.has(scope)),
    refuse: () => new Forbidden(),
    headers,
  });
  return { session, guard, guardStream };
};

/** A guest's context: every guarded field refuses it. */
export const anonymousContext = (headers?: Headers): Ctx => contextFor(undefined, headers);
