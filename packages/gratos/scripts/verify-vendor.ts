/**
 * Proves the vendored Grats files are byte-identical to upstream v0.0.36.
 *
 * It fetches the upstream git tree for the pinned commit from the GitHub API, maps every
 * vendored upstream path to its location in this package, and compares git blob hashes.
 * Any missing, changed or extra file fails the run, except inside Gratos' own folders
 * (LOCAL_PREFIXES, such as llm-docs/gratos/), which upstream must not have. Set GITHUB_TOKEN to
 * avoid the unauthenticated API rate limit.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { Schema } from "effect";

const UPSTREAM_REPO = "captbaritone/grats";
const UPSTREAM_COMMIT = "5ab66166446b4f80263cda1a13de7d3a69a1c2f8"; // tag v0.0.36

const packageRoot = join(import.meta.dirname, "..");

/** Upstream path prefix → local directory (relative to the package root). Longest prefix first. */
const MAPPINGS: ReadonlyArray<readonly [upstream: string, local: string]> = [
  ["src/tests/fixtures/", "test/fixtures/"],
  ["src/tests/integrationFixtures/", "test/integrationFixtures/"],
  ["src/tests/configParserFixtures/", "test/configParserFixtures/"],
  ["src/", "src/upstream/"],
  ["llm-docs/", "llm-docs/"],
];
const SINGLE_FILES: ReadonlyArray<readonly [upstream: string, local: string]> = [
  ["LICENSE", "LICENSE"],
];
/** Upstream directories under a mapped prefix that are deliberately not vendored. */
const EXCLUDED_PREFIXES = ["src/tests/"];
/**
 * Gratos' own folders inside a vendored root (local paths): their files are never compared with
 * upstream, and upstream must have nothing there, or the run fails. `llm-docs/gratos/` holds the
 * Effect chapter beside the vendored Grats docs (docs/plan.html M7).
 */
const LOCAL_PREFIXES = ["llm-docs/gratos/"];
const isLocalPath = (local: string): boolean =>
  LOCAL_PREFIXES.some((prefix) => local.startsWith(prefix));

const TreeResponse = Schema.Struct({
  truncated: Schema.Boolean,
  tree: Schema.Array(
    Schema.Struct({ path: Schema.String, type: Schema.String, sha: Schema.String }),
  ),
});
const decodeTreeResponse = Schema.decodeUnknownSync(TreeResponse);

const toLocal = (upstreamPath: string): string | undefined => {
  for (const [upstream, local] of SINGLE_FILES) {
    if (upstreamPath === upstream) {
      return local;
    }
  }
  for (const [upstream, local] of MAPPINGS) {
    if (upstreamPath.startsWith(upstream)) {
      const isExcluded = EXCLUDED_PREFIXES.some(
        (prefix) => upstreamPath.startsWith(prefix) && !upstream.startsWith(prefix),
      );
      return isExcluded ? undefined : local + upstreamPath.slice(upstream.length);
    }
  }
  return undefined;
};

const gitBlobSha = (content: Buffer): string =>
  createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Every non-directory entry under `dir`, without following symlinks; a symlink counts as an entry. */
const listEntries = (dir: string): Array<string> =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name));

const fetchUpstreamTree = async (): Promise<(typeof TreeResponse.Type)["tree"]> => {
  const token = process.env["GITHUB_TOKEN"];
  const headers = new Headers({ accept: "application/vnd.github+json" });
  if (token !== undefined && token !== "") {
    headers.set("authorization", `Bearer ${token}`);
  }
  const url = `https://api.github.com/repos/${UPSTREAM_REPO}/git/trees/${UPSTREAM_COMMIT}?recursive=1`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${url}`);
  }
  const body = decodeTreeResponse(await response.json());
  if (body.truncated) {
    throw new Error("Upstream tree listing is truncated; cannot verify.");
  }
  return body.tree;
};

/**
 * Intentional, reviewed changes to vendored files. Each entry pins the file's expected git blob
 * SHA (or records its removal) with the reason; anything else that differs from upstream fails.
 * Record a new set of changes with: `node scripts/verify-vendor.ts --record "<reason>"`.
 */
const ledgerPath = join(packageRoot, "vendor-changes.json");
const LedgerEntry = Schema.Union([
  Schema.Struct({ sha: Schema.String, reason: Schema.String }),
  Schema.Struct({ removed: Schema.Literal(true), reason: Schema.String }),
]);
const Ledger = Schema.Struct({
  upstream: Schema.String,
  changes: Schema.Record(Schema.String, LedgerEntry),
});
type Ledger = typeof Ledger.Type;
const decodeLedger = Schema.decodeUnknownSync(Ledger);
const UPSTREAM_REF = `${UPSTREAM_REPO}@${UPSTREAM_COMMIT}`;

const readLedger = (): Ledger =>
  existsSync(ledgerPath)
    ? decodeLedger(JSON.parse(readFileSync(ledgerPath, "utf8")))
    : { upstream: UPSTREAM_REF, changes: {} };

type LocalState =
  | { readonly kind: "missing" }
  | { readonly kind: "symlink" }
  | { readonly kind: "file"; readonly sha: string };
const localStateOf = (local: string): LocalState => {
  const absolute = join(packageRoot, local);
  // Upstream has no symlinks in the vendored set, so a symlink is always a change.
  // Checking with lstat keeps readFileSync from hashing a link target instead.
  if (isSymlink(absolute)) {
    return { kind: "symlink" };
  }
  if (!existsSync(absolute)) {
    return { kind: "missing" };
  }
  return { kind: "file", sha: gitBlobSha(readFileSync(absolute)) };
};

const main = async (): Promise<number> => {
  const recordIndex = process.argv.indexOf("--record");
  const recordReason = recordIndex === -1 ? undefined : process.argv[recordIndex + 1];
  if (recordIndex !== -1 && (recordReason === undefined || recordReason.trim() === "")) {
    process.stderr.write('usage: verify-vendor.ts [--record "<reason>"]\n');
    return 2;
  }

  const tree = await fetchUpstreamTree();
  const expected = new Map<string, string>();
  for (const entry of tree) {
    if (entry.type !== "blob") {
      continue;
    }
    const local = toLocal(entry.path);
    if (local !== undefined) {
      expected.set(local, entry.sha);
    }
  }
  const collisions = [...expected.keys()].filter(isLocalPath);

  const ledger = readLedger();
  if (ledger.upstream !== UPSTREAM_REF) {
    process.stderr.write(
      `verify-vendor: vendor-changes.json is for ${ledger.upstream}, not ${UPSTREAM_REF}\n`,
    );
    return 1;
  }
  const changes = { ...ledger.changes };
  const problems: Array<string> = collisions.map(
    (local) => `collision: upstream has ${local}, inside a folder of Gratos' own`,
  );
  for (const [local, upstreamSha] of expected) {
    const state = localStateOf(local);
    const recorded = changes[local];
    if (state.kind === "file" && state.sha === upstreamSha) {
      if (recorded !== undefined) {
        problems.push(`stale ledger entry: ${local} is identical to upstream again`);
      }
      continue;
    }
    if (state.kind === "symlink") {
      problems.push(`changed: ${local} (now a symlink)`);
      continue;
    }
    const matchesLedger =
      recorded !== undefined &&
      (state.kind === "missing"
        ? "removed" in recorded
        : "sha" in recorded && recorded.sha === state.sha);
    if (matchesLedger) {
      continue;
    }
    if (recordReason !== undefined) {
      changes[local] =
        state.kind === "missing"
          ? { removed: true, reason: recordReason }
          : { sha: state.sha, reason: recordReason };
      continue;
    }
    problems.push(
      `${state.kind === "missing" ? "missing" : "changed"}: ${local}${recorded === undefined ? "" : " (differs from vendor-changes.json)"}`,
    );
  }
  for (const local of Object.keys(changes)) {
    if (!expected.has(local)) {
      problems.push(`stale ledger entry: ${local} is not a vendored upstream file`);
    }
  }

  const vendoredRoots = [
    ...MAPPINGS.map(([, local]) => local),
    ...SINGLE_FILES.map(([, local]) => local),
  ];
  const present = vendoredRoots.flatMap((root) => {
    const absolute = join(packageRoot, root);
    if (!existsSync(absolute)) {
      return [];
    }
    return lstatSync(absolute).isDirectory() ? listEntries(absolute) : [absolute];
  });
  for (const absolute of present) {
    const local = relative(packageRoot, absolute).split(sep).join("/");
    if (!expected.has(local) && !isLocalPath(local)) {
      problems.push(`extra: ${local}`);
    }
  }

  // Record only a run that is otherwise clean, so a failed run never approves anything.
  if (recordReason !== undefined && problems.length === 0) {
    const sorted = Object.fromEntries(
      Object.entries(changes).toSorted(([a], [b]) => a.localeCompare(b)),
    );
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({ upstream: UPSTREAM_REF, changes: sorted }, null, 2)}\n`,
    );
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.stderr.write(`verify-vendor: ${problems.length} problem(s) against ${UPSTREAM_REF}\n`);
    return 1;
  }
  const changed = Object.keys(changes).length;
  const own = present.filter((absolute) =>
    isLocalPath(relative(packageRoot, absolute).split(sep).join("/")),
  ).length;
  process.stdout.write(
    `verify-vendor: ${expected.size - changed} vendored files are byte-identical to ${UPSTREAM_REF}; ${changed} differ exactly as recorded in vendor-changes.json; ${own} of Gratos' own (${LOCAL_PREFIXES.join(", ")}) are not compared\n`,
  );
  return 0;
};

process.exitCode = await main();
