// The bench job's last step (.github/workflows/ci.yml, docs/plan.html F3): reads the results of
// bench/run.ts (`--build <file>`, once per project) and the dev-loop timings that
// examples/orders' dev.test.ts wrote (`--dev <file>`), appends the summary (bench/summary.ts) to
// $GITHUB_STEP_SUMMARY (stdout without it), and prints a `::warning::` for each dev-loop timing
// above the bound (`--dev-bound-ms`, default M6's 3 s CI bound). A miss never fails it; an input
// it cannot read does, after the summary says which.
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { Schema } from "effect";

import { DEV_LOOP_CI_BOUND_MS } from "./bounds.ts";
import { BuildResult, DevTimings, summarize } from "./summary.ts";
import type { Input } from "./summary.ts";

const { values: flags } = parseArgs({
  options: {
    build: { type: "string", multiple: true, default: [] },
    dev: { type: "string" },
    "dev-bound-ms": { type: "string", default: String(DEV_LOOP_CI_BOUND_MS) },
  },
});

const devBoundMs = Number(flags["dev-bound-ms"]);
if (!(devBoundMs > 0)) {
  throw new Error(`bench: --dev-bound-ms takes a positive number, got ${flags["dev-bound-ms"]}`);
}
if (flags.dev === undefined || flags.build.length === 0) {
  throw new Error("bench: report needs --build <file> (at least one) and --dev <file>");
}

const read = <A>(schema: Schema.Codec<A>, file: string): Input<A> => {
  try {
    return {
      ok: true,
      value: Schema.decodeUnknownSync(schema)(JSON.parse(readFileSync(file, "utf8"))),
    };
  } catch (error) {
    return { ok: false, file, reason: String(error).split("\n")[0] ?? "unreadable" };
  }
};

const summary = summarize(
  flags.build.map((file) => read(BuildResult, file)),
  read(DevTimings, flags.dev),
  devBoundMs,
);

const target = process.env["GITHUB_STEP_SUMMARY"];
if (target === undefined || target === "") {
  process.stdout.write(summary.markdown);
} else {
  appendFileSync(target, summary.markdown);
}
for (const warning of summary.warnings) {
  process.stdout.write(`${warning}\n`);
}
process.exitCode = summary.complete ? 0 : 1;
