// A user type named `Effect` stays a normal GraphQL type: only `Effect.Effect` is a wrapper.

/** @gqlType */
export class Effect {
  /** @gqlField */
  name: string;
}

/** @gqlQueryField */
export function effect(): Effect {
  return new Effect();
}
