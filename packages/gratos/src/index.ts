// Public entry of gratos. Models import Grats' types from here (`Int`, `Float`, `ID`,
// `GqlInfo`, `GqlScalar`), and generated schemas import `GqlScalar` from here (the
// `libraryImport` config option). The `gratos` CLI is src/cli.ts, on the Effect shell in
// src/generate.ts.
export type { Float, GqlInfo, GqlScalar, ID, Int } from "./upstream/Types.ts";

/** Name of this package. */
export const packageName = "gratos";
