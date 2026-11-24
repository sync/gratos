// Temporary projects for tests, written under test/.scratch/ (gitignored) so that their imports
// of `effect`, `graphql` and `@dblechoc/gratos` resolve through this package's node_modules.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const scratchRoot = join(import.meta.dirname, "..", ".scratch");
const smokeDir = join(import.meta.dirname, "..", "smoke");

export interface ScratchProject {
  readonly dir: string;
  readonly path: (relativePath: string) => string;
  readonly write: (relativePath: string, content: string) => void;
  readonly remove: () => void;
}

/** A new empty project directory, with `files` written into it. */
export const scratchProject = (
  name: string,
  files: Readonly<Record<string, string>> = {},
): ScratchProject => {
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, `${name}-`));
  const path = (relativePath: string) => join(dir, relativePath);
  const write = (relativePath: string, content: string) => {
    mkdirSync(dirname(path(relativePath)), { recursive: true });
    writeFileSync(path(relativePath), content);
  };
  for (const [relativePath, content] of Object.entries(files)) {
    write(relativePath, content);
  }
  return { dir, path, write, remove: () => rmSync(dir, { recursive: true, force: true }) };
};

/** A copy of the smoke fixture's sources (models, query.ts, tsconfig.json), without its schema. */
export const smokeCopy = (name: string): ScratchProject => {
  const project = scratchProject(name);
  cpSync(join(smokeDir, "models"), project.path("models"), { recursive: true });
  cpSync(join(smokeDir, "query.ts"), project.path("query.ts"));
  cpSync(join(smokeDir, "tsconfig.json"), project.path("tsconfig.json"));
  return project;
};
