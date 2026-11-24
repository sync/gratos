// The TypeScript 7 facade's programs and config reading on real tsconfigs in temporary
// directories: program reuse, edits between parses, config diagnostics and byte order marks.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

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

describe("getParsedCommandLineOfConfigFile", () => {
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
});
