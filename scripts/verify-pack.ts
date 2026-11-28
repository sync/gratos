// The check the release workflow's publish job runs (AGENTS.md "Releasing"), on the pack output
// the release job tested and uploaded, right before `changeset publish --from-pack-dir <dir>`:
//
//   node scripts/verify-pack.ts <dir> --plan-sha256 <hex>
//
// It passes only when <dir>/publish-plan.json has the sha256 the release job recorded as a job
// output, publishes something, and every tarball it names is below <dir>, has the plan's
// integrity, and holds the package and version of its own plan entry, with no other tarball in
// <dir> (scripts/publish-plan.ts). So the publish job publishes the bytes the install test
// tested, or nothing. It runs no dependency's code: Node's built-ins only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { PUBLISH_PLAN, readPackDir } from "./publish-plan.ts";

const fail = (message: string): never => {
  process.stderr.write(`verify-pack: ${message}\n`);
  process.exit(1);
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "plan-sha256": { type: "string" } },
});
const [packDir] = positionals;
const expected = values["plan-sha256"];
if (packDir === undefined || positionals.length > 1 || expected === undefined) {
  fail("usage: node scripts/verify-pack.ts <dir> --plan-sha256 <hex>");
}
const dir = resolve(packDir ?? "");
const plan = join(dir, PUBLISH_PLAN);

const actual = (() => {
  try {
    return createHash("sha256").update(readFileSync(plan)).digest("hex");
  } catch (error) {
    return fail(`cannot read ${plan}: ${error instanceof Error ? error.message : String(error)}`);
  }
})();
if (actual !== expected) {
  fail(`${plan} has sha256 ${actual}, not the ${String(expected)} the release job recorded`);
}

const releases = (() => {
  try {
    return readPackDir(dir) ?? fail(`${dir} holds no ${PUBLISH_PLAN}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
})();
if (releases.length === 0) {
  fail(`${plan} publishes nothing`);
}
for (const release of releases) {
  process.stdout.write(
    `verify-pack: ok ${release.path} is ${release.name}@${release.version} (${release.file})\n`,
  );
}
process.stdout.write(`verify-pack: ${dir} is the pack output the release job tested\n`);
