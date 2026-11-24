import { Effect } from "effect";

/** @gqlContext */
type Ctx = { userId: string };

type Viewer = { id: string };

/** @gqlContext */
export async function viewer(ctx: Ctx): Promise<Effect.Effect<Viewer>> {
  return Effect.succeed({ id: ctx.userId });
}

/** @gqlQueryField */
export function me(viewer: Viewer): string {
  return viewer.id;
}
