// The Grats config, decoded with Schema (docs/plan.html M2/M3). The CLI reads the root tsconfig
// itself (TypeScript 7's config parser drops unknown keys) and takes the top-level `grats` key
// of that file only, with no `extends` merging, as TypeScript 5's `raw` did.
//
// The accepted keys, their types and their defaults are upstream's config spec
// (src/upstream/configSpecRaw.json); test/config.test.ts proves the schema matches it.
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { Result, Schema } from "effect";

import { GratsConfigSpec } from "../upstream/configSpec.ts";
import type { GratsConfig } from "../upstream/gratsConfig.ts";

/** A string, or an array of lines (upstream's `longString`). */
const LongString = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

/** The `grats` key as written: every option optional, no unknown option. */
export const GratsConfigInput = Schema.Struct({
  graphqlSchema: Schema.optionalKey(Schema.String),
  tsSchema: Schema.optionalKey(Schema.String),
  tsClientEnums: Schema.optionalKey(Schema.NullOr(Schema.String)),
  nullableByDefault: Schema.optionalKey(Schema.Boolean),
  strictSemanticNullability: Schema.optionalKey(Schema.Boolean),
  reportTypeScriptTypeErrors: Schema.optionalKey(Schema.Boolean),
  schemaHeader: Schema.optionalKey(Schema.NullOr(LongString)),
  tsSchemaHeader: Schema.optionalKey(Schema.NullOr(LongString)),
  tsClientEnumsHeader: Schema.optionalKey(Schema.NullOr(LongString)),
  importModuleSpecifierEnding: Schema.optionalKey(Schema.String),
  EXPERIMENTAL__emitMetadata: Schema.optionalKey(Schema.Boolean),
  EXPERIMENTAL__emitResolverMap: Schema.optionalKey(Schema.Boolean),
  libraryImport: Schema.optionalKey(Schema.String),
});

/** The parsed config, after defaults: upstream's GratsConfig type. */
export const GratsConfigSchema = Schema.Struct({
  graphqlSchema: Schema.String,
  tsSchema: Schema.String,
  tsClientEnums: Schema.NullOr(Schema.String),
  nullableByDefault: Schema.Boolean,
  strictSemanticNullability: Schema.Boolean,
  reportTypeScriptTypeErrors: Schema.Boolean,
  schemaHeader: Schema.NullOr(Schema.String),
  tsSchemaHeader: Schema.NullOr(Schema.String),
  tsClientEnumsHeader: Schema.NullOr(Schema.String),
  importModuleSpecifierEnding: Schema.String,
  EXPERIMENTAL__emitMetadata: Schema.Boolean,
  EXPERIMENTAL__emitResolverMap: Schema.Boolean,
  libraryImport: Schema.String,
});

/** The tsconfig as far as Gratos reads it: only the `grats` key. */
const Tsconfig = Schema.Struct({ grats: Schema.optionalKey(Schema.Unknown) });

/** Upstream's defaults, decoded once: a spec key the schema lacks fails here. */
export const DEFAULT_GRATS_CONFIG: GratsConfig = Schema.decodeUnknownSync(GratsConfigSchema)(
  Object.fromEntries(
    Object.entries(GratsConfigSpec.properties).map(([key, property]) => [key, property.default]),
  ),
  { onExcessProperty: "error" },
);

const joinLines = (value: string | ReadonlyArray<string> | null): string | null =>
  value === null || typeof value === "string" ? value : value.join("\n");

export interface DecodedConfig {
  readonly config: GratsConfig;
  /** Upstream's warnings for experimental options, as Gratos words them. */
  readonly warnings: ReadonlyArray<string>;
}

/** Why a tsconfig's text cannot be read as Grats config. */
export type ConfigProblem = string;

const describeParseErrors = (text: string, errors: ReadonlyArray<ParseError>): string =>
  errors
    .map((error) => {
      const before = text.slice(0, error.offset).split("\n");
      const line = before.length;
      const column = (before.at(-1)?.length ?? 0) + 1;
      return `${printParseErrorCode(error.error)} at ${line}:${column}`;
    })
    .join(", ");

/**
 * Parses a tsconfig's text (JSON with comments and trailing commas) and decodes its `grats` key
 * into upstream's GratsConfig, with upstream's defaults and `longString` joining.
 */
export const decodeGratsConfig = (text: string): Result.Result<DecodedConfig, ConfigProblem> => {
  const errors: Array<ParseError> = [];
  const raw: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    return Result.fail(`it is not valid JSON with comments (${describeParseErrors(text, errors)})`);
  }
  const tsconfig = Schema.decodeUnknownResult(Tsconfig)(raw);
  if (Result.isFailure(tsconfig)) {
    return Result.fail(`it must be a JSON object\n${tsconfig.failure.message}`);
  }
  const input = Schema.decodeUnknownResult(GratsConfigInput)(tsconfig.success.grats ?? {}, {
    onExcessProperty: "error",
  });
  if (Result.isFailure(input)) {
    return Result.fail(`its \`grats\` config is invalid\n${input.failure.message}`);
  }
  const given = input.success;
  const config: GratsConfig = {
    ...DEFAULT_GRATS_CONFIG,
    ...given,
    schemaHeader:
      given.schemaHeader === undefined
        ? DEFAULT_GRATS_CONFIG.schemaHeader
        : joinLines(given.schemaHeader),
    tsSchemaHeader:
      given.tsSchemaHeader === undefined
        ? DEFAULT_GRATS_CONFIG.tsSchemaHeader
        : joinLines(given.tsSchemaHeader),
    tsClientEnumsHeader:
      given.tsClientEnumsHeader === undefined
        ? DEFAULT_GRATS_CONFIG.tsClientEnumsHeader
        : joinLines(given.tsClientEnumsHeader),
  };
  const warnings = Object.keys(given)
    .filter((key) => GratsConfigSpec.properties[key]?.experimental === true)
    .map(
      (key) =>
        `Gratos: The \`${key}\` option is experimental and will be renamed or removed in a future release.`,
    );
  return Result.succeed({ config, warnings });
};
