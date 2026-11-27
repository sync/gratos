// The canary's two steps (.github/workflows/canary.yml, docs/plan.html F3). Nothing it changes is
// committed: it runs inside the job's checkout.
//
//   node scripts/canary.ts pin <tag> <package>...
//     Resolves the first package's <tag> on npm (`npm view`), sets every named package's catalog:
//     entry in pnpm-workspace.yaml to that exact version (effect and its @effect/* packages share
//     one), and sets minimumReleaseAge: 0, so a release younger than the default age installs.
//
//   node scripts/canary.ts verify <package>...
//     Fails unless every workspace package that takes a named package from the catalog has the
//     catalog's version installed, and prints each resolved version: the log shows that the
//     override took effect.
//
// Either fails loudly when it finds nothing to change or check, so an entry can never pass by
// testing the pins it was meant to move.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const workspaceFile = join(root, "pnpm-workspace.yaml");

const fail = (message: string): never => {
  process.stderr.write(`canary: ${message}\n`);
  process.exit(1);
};

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** The `catalog:` line of `name`, quoted or not: its prefix and its version. */
const catalogLine = (name: string): RegExp =>
  new RegExp(`^(  "?${escapeRegExp(name)}"?: )(\\S+)$`, "m");

const catalogVersion = (workspace: string, name: string): string => {
  const version = catalogLine(name).exec(workspace)?.[2];
  return version ?? fail(`${name} has no catalog: entry in pnpm-workspace.yaml`);
};

const npmVersion = (name: string, tag: string): string => {
  const output = execFileSync("npm", ["view", `${name}@${tag}`, "version", "--json"], {
    encoding: "utf8",
  });
  // A string, or (npm 11) an array of the matching versions: a tag matches exactly one.
  const parsed: unknown = JSON.parse(output);
  const versions: ReadonlyArray<unknown> = Array.isArray(parsed) ? parsed : [parsed];
  const [version] = versions;
  return versions.length === 1 && typeof version === "string"
    ? version
    : fail(`${name}@${tag} resolved to ${output.trim()}, not one version`);
};

const pin = (tag: string, names: ReadonlyArray<string>): void => {
  const [first] = names;
  if (first === undefined) {
    fail("pin needs a tag and at least one package");
    return;
  }
  const version = npmVersion(first, tag);
  let workspace = readFileSync(workspaceFile, "utf8");
  for (const name of names) {
    const before = catalogVersion(workspace, name);
    workspace = workspace.replace(catalogLine(name), `$1${version}`);
    process.stdout.write(`canary: ${name} ${before} -> ${version} (${first}@${tag})\n`);
  }
  workspace = /^minimumReleaseAge:.*$/m.test(workspace)
    ? workspace.replace(/^minimumReleaseAge:.*$/m, "minimumReleaseAge: 0")
    : `${workspace.trimEnd()}\n\nminimumReleaseAge: 0\n`;
  writeFileSync(workspaceFile, workspace);
};

/** The workspace's package directories: the root, and every package under packages/ and examples/. */
const workspaceDirs = (): ReadonlyArray<string> => [
  root,
  ...["packages", "examples"].flatMap((parent) =>
    readdirSync(join(root, parent), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json"))
        ? [join(root, parent, entry.name)]
        : [],
    ),
  ),
];

/** What verify reads from a package.json. */
interface Manifest {
  readonly version: string | undefined;
  /** The dependencies (of any kind) it takes from the catalog. */
  readonly fromCatalog: ReadonlySet<string>;
}

const DEPENDENCY_KINDS = new Set(["dependencies", "devDependencies", "peerDependencies"]);

// It runs before the install too (the pin step), so it parses JSON by hand: nothing is installed.
const readManifest = (path: string): Manifest => {
  const json: unknown = JSON.parse(readFileSync(path, "utf8"));
  let version: string | undefined;
  const fromCatalog = new Set<string>();
  if (typeof json === "object" && json !== null) {
    for (const [key, entry] of Object.entries(json)) {
      const value: unknown = entry;
      if (key === "version" && typeof value === "string") {
        version = value;
      }
      if (DEPENDENCY_KINDS.has(key) && typeof value === "object" && value !== null) {
        for (const [name, specifier] of Object.entries(value)) {
          const range: unknown = specifier;
          if (range === "catalog:") {
            fromCatalog.add(name);
          }
        }
      }
    }
  }
  return { version, fromCatalog };
};

const verify = (names: ReadonlyArray<string>): void => {
  if (names.length === 0) {
    fail("verify needs at least one package");
  }
  const workspace = readFileSync(workspaceFile, "utf8");
  for (const name of names) {
    const expected = catalogVersion(workspace, name);
    let checked = 0;
    for (const dir of workspaceDirs()) {
      if (!readManifest(join(dir, "package.json")).fromCatalog.has(name)) {
        continue;
      }
      const installedFile = join(dir, "node_modules", name, "package.json");
      const installed = existsSync(installedFile)
        ? (readManifest(installedFile).version ?? "without a version")
        : "not installed";
      const where = dir === root ? "." : dir.slice(root.length + 1);
      process.stdout.write(`canary: ${where}: ${name}@${installed}\n`);
      if (installed !== expected) {
        fail(`${where} resolved ${name}@${installed}, not the catalog's ${expected}`);
      }
      checked += 1;
    }
    if (checked === 0) {
      fail(`no workspace package takes ${name} from the catalog`);
    }
  }
};

const [command, ...rest] = process.argv.slice(2);
if (command === "pin") {
  const [tag, ...names] = rest;
  if (tag === undefined) {
    fail("pin needs a tag and at least one package");
  } else {
    pin(tag, names);
  }
} else if (command === "verify") {
  verify(rest);
} else {
  fail("usage: node scripts/canary.ts pin <tag> <package>... | verify <package>...");
}
