#!/usr/bin/env node
// The `gratos` CLI (docs/plan.html M3), on effect/cli.
//
//   gratos [--tsconfig <path>]          writes the schema files that are out of date
//   gratos --check [--tsconfig <path>]  writes nothing; exits 1 if a file is out of date
//   gratos --version (-v, or upstream Grats' -V)
//
// Without --tsconfig it uses the nearest tsconfig.json from the current directory. Node runs
// this file from source (type stripping); it loads the TypeScript 7 facade only, never the
// TypeScript 5.9.2 baseline.
import { runMain } from "@effect/platform-node/NodeRuntime";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Console, Effect, Option, Schema } from "effect";
import { CliConfig, Command, Flag, GlobalFlag } from "effect/cli";

import packageJson from "../package.json" with { type: "json" };

import { check, findTsconfig, generate } from "./generate.ts";
import type { GenerateResult, GratsError } from "./generate.ts";

const PackageJson = Schema.Struct({ version: Schema.String });
const { version } = Schema.decodeUnknownSync(PackageJson)(packageJson);

/**
 * effect/cli's built-in `--version` (alias `-v`), also accepting `-V`: upstream Grats' CLI
 * (commander) documents `-V, --version`. Every other built-in is kept as it is.
 */
const versionFlag = {
  ...GlobalFlag.Version,
  flag: GlobalFlag.Version.flag.pipe(Flag.withAlias("V")),
} satisfies GlobalFlag.Action<boolean>;
const cliConfig = CliConfig.layer({
  builtIns: GlobalFlag.BuiltIns.map((flag) => (flag === GlobalFlag.Version ? versionFlag : flag)),
});

const reportFiles = (result: GenerateResult, checked: boolean) =>
  Effect.forEach(
    [
      ...result.diagnostics,
      ...result.files.map((file) =>
        file.upToDate || checked
          ? `Gratos: \`${file.name}\` is up to date.`
          : `Gratos: Wrote \`${file.path}\`.`,
      ),
    ],
    (line) => Console.error(line),
    { discard: true },
  );

const reportError = (error: GratsError) =>
  Console.error(error._tag === "DiagnosticsError" ? error.formatted : error.message);

const gratos = Command.make(
  "gratos",
  {
    tsconfig: Flag.String("tsconfig").pipe(
      Flag.withDescription(
        "Path to tsconfig.json. Defaults to the nearest tsconfig.json from the current directory.",
      ),
      Flag.optional,
    ),
    check: Flag.Boolean("check").pipe(
      Flag.withDescription(
        "Write nothing; exit with status 1 if a generated file is missing or out of date.",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fnUntraced(
    function* ({ tsconfig, check: checkOnly }) {
      const configPath = Option.isSome(tsconfig)
        ? tsconfig.value
        : yield* findTsconfig(process.cwd());
      const result = yield* checkOnly ? check(configPath) : generate(configPath);
      yield* reportFiles(result, checkOnly);
    },
    Effect.scoped,
    Effect.tapError(reportError),
  ),
).pipe(Command.withDescription("Generate a GraphQL schema from your TypeScript project."));

Command.run(gratos, { version }).pipe(
  Effect.tapDefect((defect) => Console.error("Gratos: unexpected error", defect)),
  Effect.provide([NodeServicesLayer, cliConfig]),
  runMain({ disableErrorReporting: true }),
);
