/**
 * Proves the vendored Grats files are byte-identical to upstream v0.0.36.
 *
 * It fetches the upstream git tree for the pinned commit from the GitHub API, maps every
 * vendored upstream path to its location in this package, and compares git blob hashes.
 * Any missing, changed or extra file fails the run. Set GITHUB_TOKEN to avoid the
 * unauthenticated API rate limit.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
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

const main = async (): Promise<number> => {
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

  const problems: Array<string> = [];
  for (const [local, sha] of expected) {
    let content: Buffer;
    try {
      content = readFileSync(join(packageRoot, local));
    } catch {
      problems.push(`missing: ${local}`);
      continue;
    }
    if (gitBlobSha(content) !== sha) {
      problems.push(`changed: ${local}`);
    }
  }

  const vendoredRoots = [
    ...MAPPINGS.map(([, local]) => local),
    ...SINGLE_FILES.map(([, local]) => local),
  ];
  const present = vendoredRoots.flatMap((root) => {
    const absolute = join(packageRoot, root);
    if (!existsSync(absolute)) {
      return []; // its files are already reported as missing
    }
    return lstatSync(absolute).isDirectory() ? listEntries(absolute) : [absolute];
  });
  for (const absolute of present) {
    const local = relative(packageRoot, absolute).split(sep).join("/");
    if (!expected.has(local)) {
      problems.push(`extra: ${local}`);
    }
  }

  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.stderr.write(
      `verify-vendor: ${problems.length} problem(s) against ${UPSTREAM_REPO}@${UPSTREAM_COMMIT}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `verify-vendor: all ${expected.size} vendored files are byte-identical to ${UPSTREAM_REPO}@${UPSTREAM_COMMIT}\n`,
  );
  return 0;
};

process.exitCode = await main();
