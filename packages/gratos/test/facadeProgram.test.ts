// The TypeScript 7 facade's programs and config reading on real tsconfigs in temporary
// directories: program reuse, edits between parses, config diagnostics and byte order marks.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { formatDiagnosticsWithColorAndContext } from "../src/ts/diagnostics.ts";
import type { Diagnostic } from "../src/ts/diagnostics.ts";
import { getParsedCommandLineOfConfigFile } from "../src/ts/program.ts";
import { closeDefaultSessions } from "../src/ts/session.ts";

const directories: Array<string> = [];

/** A temporary directory holding `files`; returns its path. */
const project = (files: Record<string, string>): string => {
  const directory = mkdtempSync(join(tmpdir(), "gratos-facade-"));
  directories.push(directory);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(directory, name), text);
  }
  return directory;
};

afterAll(() => {
  closeDefaultSessions();
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A strict tsconfig, optionally with a `target`. */
const tsconfig = (compilerOptions: { readonly target?: string } = {}): string =>
  JSON.stringify({ compilerOptions: { strict: true, ...compilerOptions } }, null, 2);

const format = (diagnostics: ReadonlyArray<Diagnostic>, directory: string): string =>
  stripVTControlCharacters(
    formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => directory,
      getCanonicalFileName: (fileName) => fileName,
      getNewLine: () => "\n",
    }),
  );

describe("getParsedCommandLineOfConfigFile", () => {
  it("sees a source file edited since the config was last parsed", () => {
    const directory = project({ "tsconfig.json": tsconfig(), "a.ts": "export const a = 1;\n" });
    const configPath = join(directory, "tsconfig.json");
    const fileName = join(directory, "a.ts");
    expect(getParsedCommandLineOfConfigFile(configPath).program.getSourceFile(fileName)?.text).toBe(
      "export const a = 1;\n",
    );

    writeFileSync(fileName, "export const a = 2;\n");
    expect(getParsedCommandLineOfConfigFile(configPath).program.getSourceFile(fileName)?.text).toBe(
      "export const a = 2;\n",
    );
  });

  it("reports an invalid compiler option at its place in the tsconfig", () => {
    const text = tsconfig({ target: "es1" });
    const directory = project({ "tsconfig.json": text, "a.ts": "export const a = 1;\n" });
    const configPath = join(directory, "tsconfig.json");
    const { errors } = getParsedCommandLineOfConfigFile(configPath);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.file?.fileName).toBe(configPath);
    expect(errors[0]?.start).toBe(text.indexOf('"es1"'));
    expect(errors[0]?.length).toBe('"es1"'.length);
    expect(format(errors, directory)).toMatch(
      /^tsconfig\.json:4:15 - error TS6046: Argument for '--target' option must be: .*\n\n4 {5}"target": "es1"\n {16}~{5}\n/,
    );
  });

  it("reads a tsconfig that starts with a byte order mark", () => {
    const directory = project({
      "tsconfig.json": `\uFEFF${JSON.stringify({ grats: { tsSchema: "./schema.ts" } })}`,
      "a.ts": "export const a = 1;\n",
    });
    const parsed = getParsedCommandLineOfConfigFile(join(directory, "tsconfig.json"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.raw).toEqual({ grats: { tsSchema: "./schema.ts" } });
    expect(parsed.fileNames).toEqual([join(directory, "a.ts")]);
  });

  it("places config diagnostics after a byte order mark as TypeScript 5 does", () => {
    const text = tsconfig({ target: "es1" });
    const directory = project({ "tsconfig.json": `\uFEFF${text}`, "a.ts": "" });
    const { errors } = getParsedCommandLineOfConfigFile(join(directory, "tsconfig.json"));
    expect(errors[0]?.start).toBe(text.indexOf('"es1"'));
    expect(format(errors, directory)).toContain("tsconfig.json:4:15 - error TS6046");
  });
});
