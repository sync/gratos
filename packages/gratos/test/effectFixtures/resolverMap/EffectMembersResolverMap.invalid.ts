// { "EXPERIMENTAL__emitResolverMap": true }
import { Effect } from "effect";

/** Every Effect-backed member is reported: a property, a getter and a method. */
/** @gqlType */
export class User {
  /** @gqlField */
  name: Effect.Effect<string> = Effect.succeed("Ada");

  /** @gqlField */
  get email(): Effect.Effect<string> {
    return Effect.succeed("ada@example.com");
  }

  /** @gqlField */
  greeting(): Effect.Effect<string> {
    return Effect.succeed("hello");
  }

  /** A plain field is fine. */
  /** @gqlField */
  id: string = "u-1";
}
