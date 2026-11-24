// Public entry of @dblechoc/gratos. Models import Grats' types from here (`Int`, `Float`, `ID`,
// `GqlInfo`, `GqlScalar`), and generated schemas import `GqlScalar` from here (the
// `libraryImport` config option). The CLI is src/upstream/cli.ts until M3.
export type { Float, GqlInfo, GqlScalar, ID, Int } from "./upstream/Types.ts";

/** Name of this package. */
export const packageName = "@dblechoc/gratos";
