// `pnpm run release` (AGENTS.md "Releasing"): everything before the publish, in one command, for
// a release by hand (the bootstrap):
//
//   1. the publish plan: `changeset publish-plan --output <file>`, which asks the registry which
//      versions it lacks. When it publishes nothing, the script stops there, before the gate:
//      every push to main with no pending changeset lands here once publishing is on;
//   2. the gate (`release:gate`: `pnpm check` and `vendor:verify`);
//   3. `changeset pack --from-publish-plan <file> --out-dir .pack`: the tarballs of that same plan,
//      with .pack/publish-plan.json naming each one and its integrity;
//   4. the install test on .pack, for min, newest and core (`release:test`).
//
// `pnpm run release:pack` (`--pack-only`) is steps 1 and 3 only, for the release workflow's
// `release` job: that job uploads .pack, and records its plan's sha256, before any test runs, and
// the `test` job then runs the gate and the install test on the uploaded pack.
//
// It never publishes: `changeset publish --from-pack-dir .pack` (`release:publish`) does, from
// the release workflow's publish job or by hand. Node's built-ins only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { readPlan } from "./publish-plan.ts";

const root = join(import.meta.dirname, "..");
const packDir = join(root, ".pack");

const log = (line: string): void => {
  process.stdout.write(`release: ${line}\n`);
};

/**
 * The environment of every step but the gate: the caller's, without GITHUB_TOKEN, which only
 * the gate's `vendor:verify` uses. The pack runs each package's prepack, and the install test
 * runs freshly resolved peers, so neither gets the release job's token.
 */
const withoutToken = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "GITHUB_TOKEN"),
);

/** Runs `pnpm <args>` in the root, its output inherited, and returns its exit status. */
const pnpm = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = withoutToken): number => {
  log(`pnpm ${args.join(" ")}`);
  const result = spawnSync("pnpm", args, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) {
    log(`pnpm ${args.join(" ")} failed (${String(result.status ?? result.signal)})`);
  }
  return result.status ?? 1;
};

const { values } = parseArgs({ options: { "pack-only": { type: "boolean", default: false } } });
const packOnly = values["pack-only"];

/** The release up to the publish; returns the exit status. */
const release = (planFile: string): number => {
  const planned = pnpm(["exec", "changeset", "publish-plan", "--output", planFile]);
  if (planned !== 0) {
    return planned;
  }
  const releases = readPlan(planFile, { packed: false });
  if (releases.length === 0) {
    log(
      "the publish plan publishes nothing: every version is on the registry, so nothing is gated, packed or tested",
    );
    // Run as a changesets/action publish script, the action reads the CHANGESETS_OUTPUT file the
    // Changesets CLI writes, and warns when it is missing: an empty one says nothing was published.
    const output = process.env["CHANGESETS_OUTPUT"];
    if (output !== undefined && output !== "") {
      writeFileSync(output, "", { flag: "a" });
    }
    return 0;
  }
  log(
    `the publish plan publishes ${releases.map((entry) => `${entry.name}@${entry.version}`).join(", ")}`,
  );
  const pack = ["exec", "changeset", "pack", "--from-publish-plan", planFile, "--out-dir", packDir];
  const steps: ReadonlyArray<readonly [ReadonlyArray<string>, NodeJS.ProcessEnv?]> = packOnly
    ? [[pack]]
    : [[["run", "release:gate"], process.env], [pack], [["run", "release:test"]]];
  for (const [args, env] of steps) {
    const status = pnpm(args, env);
    if (status !== 0) {
      return status;
    }
  }
  log(
    packOnly
      ? `${packDir} is packed, untested: the release workflow's \`test\` job gates and tests it`
      : `${packDir} is packed and tested; \`pnpm run release:publish\` publishes it`,
  );
  return 0;
};

rmSync(packDir, { recursive: true, force: true });
// The plan lives outside the workspace, so the gate (oxfmt and oxlint on `.`) never reads it.
const scratch = mkdtempSync(join(tmpdir(), "gratos-release-"));
let status = 1;
try {
  status = release(join(scratch, "publish-plan.json"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(status);
