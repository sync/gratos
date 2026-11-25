// The request context every resolver receives.
import type { Guard } from "@dblechoc/gratos-server/effect";

import type { AppError } from "../services/errors.ts";

/** @gqlContext */
export interface Ctx {
  readonly viewer: string;
  readonly guard: Guard<AppError>["guard"];
  readonly guardStream: Guard<AppError>["guardStream"];
}
