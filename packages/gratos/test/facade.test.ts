// The TypeScript 7 facade (src/ts/): fast loading, the printer and config reading.
import { realpathSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { getParsedCommandLineOfConfigFile } from "../src/ts/program.ts";
import { createPrinter } from "../src/ts/printer.ts";
import { factory, ListFormat } from "../src/ts/index.ts";
import {
  BLANK_SOURCE,
  bundledLibDirectory,
  closeDefaultSessions,
  ownPublicDeclarations,
  readFileOverride,
} from "../src/ts/session.ts";
import { getParsedTsConfig } from "../src/upstream/index.ts";
import { buildSchemaAndDocResult } from "../src/upstream/lib.ts";
import { ReportableDiagnostics } from "../src/upstream/utils/DiagnosticError.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const smokeConfig = join(import.meta.dirname, "smoke", "tsconfig.json");
const policy = (blankThirdParty: boolean) => ({
  blankThirdParty,
  virtualFiles: new Map<string, string>(),
  filesRead: new Set<string>(),
  blanked: new Set<string>(),
});
const graphqlDir = join(
  repoRoot,
  "node_modules",
  ".pnpm",
  "graphql@17.1.0",
  "node_modules",
  "graphql",
);

afterAll(() => {
  closeDefaultSessions();
});

describe("fast loading (readFile policy)", () => {
  it("blanks third-party code files", () => {
    expect(readFileOverride(policy(true), join(graphqlDir, "index.d.mts"))).toBe(BLANK_SOURCE);
    expect(readFileOverride(policy(true), join(graphqlDir, "index.mjs"))).toBe(BLANK_SOURCE);
  });

  it("never blanks package.json", () => {
    expect(readFileOverride(policy(true), join(graphqlDir, "package.json"))).toBeUndefined();
  });

  it("serves TypeScript's lib files in full", () => {
    expect(bundledLibDirectory).toContain("node_modules");
    expect(
      readFileOverride(policy(true), join(bundledLibDirectory, "lib.es2022.d.ts")),
    ).toBeUndefined();
  });

  it("serves this package's own public declarations in full, also under node_modules", () => {
    // An installed @dblechoc/gratos is under node_modules: its declarations stand in here for the
    // ones it would serve, so this fails if the policy blanks them.
    const installed = join(graphqlDir, "index.d.mts");
    expect(readFileOverride(policy(true), installed, new Set([installed]))).toBeUndefined();
    expect(
      readFileOverride(policy(true), join(graphqlDir, "index.mjs"), new Set([installed])),
    ).toBe(BLANK_SOURCE);
  });

  it("finds its own public declarations beside the build of this module", () => {
    // src/ts/session.ts here; dist/ts/session.js once built (tsconfig.build-dts.json).
    const outDir = realpathSync(join(import.meta.dirname, "..", "src"));
    expect([...ownPublicDeclarations].map((file) => file.slice(outDir.length + 1))).toEqual([
      "index.d.ts",
      "devApi.d.ts",
      join("upstream", "Types.d.ts"),
    ]);
  });

  it("serves workspace files in full", () => {
    expect(
      readFileOverride(
        policy(true),
        join(import.meta.dirname, "..", "src", "upstream", "Types.ts"),
      ),
    ).toBeUndefined();
  });

  it("blanks nothing when TypeScript errors are reported", () => {
    expect(readFileOverride(policy(false), join(graphqlDir, "index.d.mts"))).toBeUndefined();
  });
});

describe("a program from a real tsconfig", () => {
  const parsed = getParsedCommandLineOfConfigFile(smokeConfig);
  const session = parsed.program.session;
  const program = parsed.program.project.program;
  const libFiles = program
    .getSourceFileNames()
    .filter((fileName) => program.getSourceFileMetadata(fileName)?.isDefaultLibrary);

  it("reads the grats key from the root tsconfig", () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.raw).toMatchObject({ grats: { tsSchema: "./schema.ts" } });
  });

  it("blanks third-party code but loads lib files in full", () => {
    expect(session.blankThirdParty).toBe(true);
    expect([...session.blanked].some((fileName) => fileName.includes("/graphql@17.1.0/"))).toBe(
      true,
    );
    expect(libFiles.length).toBeGreaterThan(0);
    expect(libFiles.filter((fileName) => session.blanked.has(fileName))).toEqual([]);
    // The lib's Promise declaration is really there: the checker resolves it.
    const orderFile = parsed.program.getSourceFile(
      join(import.meta.dirname, "smoke", "models", "Order.ts"),
    );
    expect(orderFile?.text).toContain("Promise<Array<Order>>");
    const lib = parsed.program.getSourceFiles();
    expect(lib.some((sourceFile) => sourceFile.fileName.includes("lib."))).toBe(false);
  });

  it("never blanks package.json", () => {
    const packageJsons = [...session.filesRead].filter((fileName) =>
      fileName.endsWith("package.json"),
    );
    expect(packageJsons.length).toBeGreaterThan(0);
    expect([...session.blanked].filter((fileName) => fileName.endsWith(".json"))).toEqual([]);
  });
});

describe("the engine on a real tsconfig", () => {
  it("resolves the built-in scalars from Types.ts through @dblechoc/gratos", () => {
    const config = getParsedTsConfig(smokeConfig);
    if (config.kind === "ERROR") {
      throw new Error(
        ReportableDiagnostics.fromDiagnostics(config.err).formatDiagnosticsWithContext(),
      );
    }
    const result = buildSchemaAndDocResult(config.value);
    if (result.kind === "ERROR") {
      throw new Error(
        ReportableDiagnostics.fromDiagnostics(result.err).formatDiagnosticsWithContext(),
      );
    }
    const order = result.value.schema.getType("Order");
    expect(order?.toString()).toBe("Order");
    expect(result.value.schema.getType("Int")?.name).toBe("Int");
    expect(result.value.schema.getType("ID")?.name).toBe("ID");
  });
});

describe("the printer", () => {
  it("prints a synthetic node with no program open", () => {
    closeDefaultSessions();
    const printer = createPrinter();
    const statement = factory.createReturnStatement(
      factory.createCallExpression(
        factory.createIdentifier("assertNonNull"),
        [],
        [factory.createTrue()],
      ),
    );
    expect(printer.printList(ListFormat.MultiLine, [statement], undefined)).toBe(
      "return assertNonNull(true);\n",
    );
  });
});
