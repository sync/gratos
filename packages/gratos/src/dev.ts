// @dblechoc/gratos/dev: the dev boot step (docs/plan.html M6).
//
// `pnpm dev` runs the app under `GRATS_DEV=1 node --watch-path=src/models --watch-path=src/services
// src/server.ts`, and the server imports this entry lazily, only when GRATS_DEV=1, so a
// production start never loads the compiler (or TypeScript). On boot, loadSchema() runs
// generate() for the app's tsconfig, which writes only the generated files whose content changed
// (src/generated/ is not watched, so writing it never restarts the process), and then imports
// the generated schema module (and the app's wiring) through the app's own `load` callback.
//
// When the models do not build, loadSchema() does not throw: it returns a failed Result whose
// GratsDevError answers every request with a 500 and `extensions.code: "GRATS_ERROR"` plus the
// diagnostics, so the server still starts. --watch-path watches folders, not the import graph,
// so the next good save restarts it. Each restart is a fresh process: the server's caches (APQ,
// JIT) and its open subscriptions start over.
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Cause, Effect } from "effect";

import { GRATS_ERROR, GratsDevError } from "./devApi.ts";
import type {
  DevDiagnostic,
  DevOptions,
  devSchema as declaredDevSchema,
  loadSchema as declaredLoadSchema,
} from "./devApi.ts";
import { generate } from "./generate.ts";
import type { GratsError } from "./generate.ts";
import { diagnosticPosition, flattenDiagnosticMessageText } from "./ts/diagnostics.ts";

const pathOf = (tsconfig: string | URL): string =>
  typeof tsconfig === "string" ? resolve(tsconfig) : fileURLToPath(tsconfig);

const devError = (error: GratsError): GratsDevError => {
  if (error._tag !== "DiagnosticsError") {
    return new GratsDevError({
      message: error.message,
      diagnostics: [{ message: error.message }],
      formatted: error.message,
    });
  }
  const diagnostics = error.diagnostics.map((diagnostic): DevDiagnostic => {
    const message = flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (diagnostic.file === undefined) {
      return { message };
    }
    return {
      message,
      file: relative(process.cwd(), diagnostic.file.fileName),
      ...diagnosticPosition(diagnostic.file, diagnostic.start ?? 0),
    };
  });
  const [first] = diagnostics;
  const more = diagnostics.length > 1 ? ` (and ${diagnostics.length - 1} more)` : "";
  return new GratsDevError({
    message: `Gratos could not build the schema: ${first?.message ?? "unknown error"}${more}`,
    diagnostics,
    formatted: error.formatted,
  });
};

const loadError = (cause: unknown): GratsDevError => {
  const message = `Gratos could not load the app: ${String(cause)}`;
  return new GratsDevError({
    message,
    diagnostics: [{ message: String(cause) }],
    formatted: message,
  });
};

const unexpectedError = (cause: Cause.Cause<never>): GratsDevError => {
  const formatted = Cause.pretty(cause);
  return new GratsDevError({
    message: "Gratos failed unexpectedly while building the schema.",
    diagnostics: [{ message: formatted }],
    formatted,
  });
};

/**
 * The boot step as an Effect: generate() for `options.tsconfig` (writing only the files whose
 * content changed), then `options.load()`. Every failure, a defect included, is a GratsDevError,
 * so the caller can always start a server.
 */
export const devSchema: typeof declaredDevSchema = (options) => {
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const started = performance.now();
  const elapsed = () => `${Math.round(performance.now() - started)} ms`;
  return Effect.gen(function* () {
    const result = yield* generate(pathOf(options.tsconfig)).pipe(
      Effect.scoped,
      Effect.mapError(devError),
    );
    for (const line of result.diagnostics) {
      log(line);
    }
    const written = result.files.filter((file) => !file.upToDate).map((file) => file.name);
    const module = yield* Effect.tryPromise({ try: options.load, catch: loadError });
    log(
      written.length > 0
        ? `Gratos: wrote ${written.join(", ")} (${elapsed()}).`
        : `Gratos: the schema is up to date (${elapsed()}).`,
    );
    return module;
  }).pipe(
    Effect.catchDefect((defect) => Effect.fail(unexpectedError(Cause.die(defect)))),
    Effect.tapError((error) =>
      Effect.sync(() => {
        log(error.formatted);
        log(
          `Gratos: every request answers 500 ${GRATS_ERROR} until the next good save (${elapsed()}).`,
        );
      }).pipe(
        // Outside catchDefect above: a logger that throws must not replace the error it reports.
        // The terminal still gets the error, on standard error.
        Effect.catchDefect((defect) =>
          Effect.sync(
            () =>
              void process.stderr.write(
                `${error.formatted}\nGratos: the dev log failed: ${String(defect)}\n`,
              ),
          ),
        ),
        Effect.catchDefect(() => Effect.void),
      ),
    ),
  );
};

/**
 * Runs the boot step on Node's file system: the generated schema module, or the GratsDevError
 * a server answers every request with. It never rejects.
 */
export const loadSchema: typeof declaredLoadSchema = (options) =>
  Effect.runPromise(devSchema(options).pipe(Effect.result, Effect.provide(NodeServicesLayer)));

export { GRATS_ERROR, GratsDevError };
export type { DevDiagnostic, DevOptions };
