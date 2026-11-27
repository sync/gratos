// The bench's synthetic project, its file statistics and its baseline (docs/plan.html M3), shared
// by bench/run.ts and the files-loaded test (test/filesLoaded.test.ts).
//
// The fixture is 300 @gqlType classes with Promise fields and @gqlQueryField functions, each
// importing effect, @effect/platform-node and graphql, so fast loading really blanks third-party
// files. It must be written inside this package (bench/.fixture/, test/.scratch/), so that those
// imports resolve through its node_modules.
import { readFileSync } from "node:fs";

import { Schema } from "effect";

import { getParsedCommandLineOfConfigFile } from "../src/ts/program.ts";
import { closeDefaultSessions } from "../src/ts/session.ts";

export const MODEL_COUNT = 300;

/** The baseline at the repo root: the synthetic fixture's numbers on the runner it records. */
export const SYNTHETIC_BASELINE = new URL("../../../bench/baseline.json", import.meta.url);

const model = (index: number): string => {
  const next = index + 1 < MODEL_COUNT ? `Model${index + 1}` : null;
  return `import type { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import type { GraphQLResolveInfo } from "graphql";
import type { Int } from "@dblechoc/gratos";
${next === null ? "" : `import { ${next} } from "./${next}.ts";\n`}
/** Model number ${index}. */
/** @gqlType */
export class Model${index} {
  /** @gqlField */
  id: string;
  /** @gqlField */
  rank: Int;
  /** @gqlField */
  active: boolean;

  constructor(id: string, rank: Int) {
    this.id = id;
    this.rank = rank;
    this.active = rank % 2 === 0;
  }

  /** @gqlField */
  async label(): Promise<string> {
    return \`model-\${this.id}\`;
  }
${
  next === null
    ? ""
    : `
  /** @gqlField */
  async next(): Promise<${next}> {
    return new ${next}(\`\${this.id}+\`, this.rank + 1);
  }
`
}}

/** @gqlQueryField */
export async function model${index}(): Promise<Model${index}> {
  return new Model${index}("${index}", ${index});
}

export const load${index} = Effect.succeed(new Model${index}("${index}", ${index}));
export type Runtime${index} = typeof NodeRuntime;
export type Info${index} = GraphQLResolveInfo;
`;
};

/** One file of the synthetic project, by its path relative to the project's directory. */
export interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

/** The synthetic project's files. */
export const syntheticFixtureFiles = (): ReadonlyArray<FixtureFile> => {
  const files: Array<FixtureFile> = [
    {
      path: "tsconfig.json",
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: "es2022",
            lib: ["es2022"],
            module: "nodenext",
            moduleResolution: "nodenext",
            types: ["node"],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            allowImportingTsExtensions: true,
          },
          include: ["models/**/*.ts"],
          grats: { importModuleSpecifierEnding: ".ts", schemaHeader: null, tsSchemaHeader: null },
        },
        null,
        2,
      )}\n`,
    },
  ];
  for (let index = 0; index < MODEL_COUNT; index++) {
    files.push({ path: `models/Model${index}.ts`, content: model(index) });
  }
  return files;
};

/**
 * The program's file statistics for `tsconfigPath`, read the way the compiler opens it (fast
 * loading unless its Grats config reports TypeScript errors). Closes the default sessions after.
 */
export const fileStats = (tsconfigPath: string) => {
  const parsed = getParsedCommandLineOfConfigFile(tsconfigPath);
  const { session, project } = parsed.program;
  const programFiles = project.program.getSourceFileNames();
  const stats = {
    /** The spec's "files loaded": every source file in the program. */
    filesLoaded: programFiles.length,
    libFiles: programFiles.filter(
      (fileName) => project.program.getSourceFileMetadata(fileName)?.isDefaultLibrary,
    ).length,
    filesRead: session.filesRead.size,
    blankedFiles: programFiles.filter((fileName) => session.blanked.has(fileName)).length,
    fullyLoadedFiles: programFiles.filter((fileName) => !session.blanked.has(fileName)).length,
  };
  closeDefaultSessions();
  return stats;
};

export const Baseline = Schema.Struct({
  runner: Schema.Struct({
    platform: Schema.String,
    cpu: Schema.String,
    cores: Schema.Number,
    memoryGb: Schema.Number,
    node: Schema.String,
  }),
  filesLoaded: Schema.Number,
  coldBuildMs: Schema.Number,
  peakRssMb: Schema.Number,
});

export const readBaseline = (path: string | URL): typeof Baseline.Type =>
  Schema.decodeUnknownSync(Baseline)(JSON.parse(readFileSync(path, "utf8")));
