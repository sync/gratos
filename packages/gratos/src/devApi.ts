// The public API of gratos/dev (docs/plan.html M6), without the compiler.
//
// package.json points the `./dev` entry's `types` condition here, and its runtime at src/dev.ts.
// A consumer's typecheck (examples/orders) then never reaches the vendored engine, which only
// typechecks under this package's own tsconfig (its `#typescript` paths mapping and upstream's
// strictness). src/dev.ts implements the two functions declared below, and is typechecked
// against these declarations. This module itself imports only `effect`.
import { Data } from "effect";
import type { Effect, FileSystem, Result } from "effect";

/** The `extensions.code` of every error a server answers with while its models do not build. */
export const GRATS_ERROR = "GRATS_ERROR";

/** One diagnostic, as a GRATS_ERROR response carries it. `line` and `column` are 1-based. */
export interface DevDiagnostic {
  readonly message: string;
  /** Relative to the current directory, as the terminal output prints it. */
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

/** The models do not build, or the app (`load`) could not be loaded. */
export class GratsDevError extends Data.TaggedError("GratsDevError")<{
  readonly message: string;
  readonly diagnostics: ReadonlyArray<DevDiagnostic>;
  /** The diagnostics as the terminal shows them: with color and source context. */
  readonly formatted: string;
}> {
  /**
   * A new 500 answer for any request: one GraphQL error with `extensions.code: "GRATS_ERROR"`
   * and the diagnostics. Each call builds a new Response (a body can be read only once).
   */
  response(): Response {
    const body = {
      errors: [
        {
          message: this.message,
          extensions: { code: GRATS_ERROR, diagnostics: this.diagnostics },
        },
      ],
    };
    return new Response(JSON.stringify(body), {
      status: 500,
      headers: {
        "content-type": "application/graphql-response+json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
}

export interface DevOptions<M> {
  /** The app's tsconfig.json (the one with the `grats` key), as a path or a file URL. */
  readonly tsconfig: string | URL;
  /**
   * Imports the generated schema module, once generate() has written it, for example
   * `() => import("./generated/schema.ts")`. Called only when the models build. Import here
   * everything that comes from the watched folders (the app's wiring and services too): a module
   * that fails to load here is a GratsDevError, one imported statically stops the server.
   */
  readonly load: () => Promise<M>;
  /** Where the boot step reports, a line at a time. Default: standard error. */
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * The boot step as an Effect: generate() for `options.tsconfig` (writing only the files whose
 * content changed), then `options.load()`. Every failure, a defect included, is a GratsDevError,
 * so the caller can always start a server.
 */
export declare const devSchema: <M>(
  options: DevOptions<M>,
) => Effect.Effect<M, GratsDevError, FileSystem.FileSystem>;

/**
 * Runs the boot step on Node's file system: the generated schema module, or the GratsDevError
 * a server answers every request with. It never rejects.
 */
export declare const loadSchema: <M>(
  options: DevOptions<M>,
) => Promise<Result.Result<M, GratsDevError>>;
