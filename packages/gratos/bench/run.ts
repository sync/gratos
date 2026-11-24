// `pnpm --filter @dblechoc/gratos bench`: cold build of a synthetic 300-model project.
//
// It writes the fixture to bench/.fixture/ (gitignored): 300 @gqlType classes with Promise
// fields and @gqlQueryField functions, each importing effect, @effect/platform-node and graphql,
// so fast loading really blanks third-party files. It then runs the CLI in fresh Node processes
// (each spawns its own tsgo, so every run is a cold build) and reports the timings, plus the
// files TypeScript loaded, read in full and blanked for the same build.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getParsedCommandLineOfConfigFile } from "../src/ts/program.ts";
import { closeDefaultSessions } from "../src/ts/session.ts";

const MODEL_COUNT = 300;
const RUNS = 5;
const BUDGET_MS = 1500;

const packageDir = join(import.meta.dirname, "..");
const fixtureDir = join(import.meta.dirname, ".fixture");
const modelsDir = join(fixtureDir, "models");

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

const writeFixture = (): void => {
  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(
    join(fixtureDir, "tsconfig.json"),
    `${JSON.stringify(
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
  );
  for (let index = 0; index < MODEL_COUNT; index++) {
    writeFileSync(join(modelsDir, `Model${index}.ts`), model(index));
  }
};

const coldBuild = (): number => {
  const start = performance.now();
  const run = spawnSync(
    process.execPath,
    [
      join(packageDir, "src", "upstream", "cli.ts"),
      "--tsconfig",
      join(fixtureDir, "tsconfig.json"),
    ],
    { cwd: packageDir, encoding: "utf8" },
  );
  const elapsed = performance.now() - start;
  if (run.status !== 0) {
    throw new Error(`gratos failed on the bench fixture:\n${run.stderr}`);
  }
  return elapsed;
};

const fileStats = () => {
  const parsed = getParsedCommandLineOfConfigFile(join(fixtureDir, "tsconfig.json"));
  const { session, project } = parsed.program;
  const programFiles = project.program.getSourceFileNames();
  const stats = {
    programFiles: programFiles.length,
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

writeFixture();
const timings = Array.from({ length: RUNS }, coldBuild);
const sorted = timings.toSorted((a, b) => a - b);
const median = sorted[Math.floor(RUNS / 2)] ?? 0;
const result = {
  models: MODEL_COUNT,
  coldBuildMs: {
    median: Math.round(median),
    min: Math.round(sorted[0] ?? 0),
    runs: timings.map(Math.round),
  },
  budgetMs: BUDGET_MS,
  files: fileStats(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (median > BUDGET_MS) {
  process.stderr.write(
    `bench: median cold build ${Math.round(median)} ms exceeds ${BUDGET_MS} ms\n`,
  );
  process.exitCode = 1;
}
