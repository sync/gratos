// A production start (no watch, no GRATS_DEV) never loads TypeScript or the dev boot step
// (docs/plan.html M6 "Done when"): every module the server process resolves is recorded, and
// `typescript` is absent. The same recording of a dev boot finds both, so the recording works.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { copyApp, exampleDir, post, start, until } from "./support/app.ts";
import type { Running } from "./support/app.ts";

const scratch = mkdtempSync(join(tmpdir(), "gratos-orders-modules-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const recorder = join(import.meta.dirname, "support", "recordModules.ts");

/** The modules a server boot resolved, recorded until it answered a query and stopped. */
const modulesOf = async (
  name: string,
  cwd: string,
  env: Record<string, string>,
): Promise<Array<string>> => {
  const modulesFile = join(scratch, `${name}.json`);
  const server: Running = await start(cwd, ["--import", recorder, "src/server.ts"], {
    ...env,
    GRATOS_RECORD_MODULES: modulesFile,
  });
  try {
    await until(
      async () => {
        const answer = await post(server.url, { query: '{ order(id: "o-1") { id } }' });
        return answer?.status === 200 ? answer : undefined;
      },
      { timeoutMs: 15_000, message: `the ${name} server never answered`, app: server },
    );
  } finally {
    await server.stop();
  }
  const parsed: unknown = JSON.parse(readFileSync(modulesFile, "utf8"));
  return Array.isArray(parsed) ? parsed.map(String) : [];
};

const isTypescript = (url: string) => /\/node_modules\/typescript\/|\/typescript@/.test(url);
const isDevEntry = (url: string) => url.endsWith("/gratos/src/dev.ts");

describe("a production start", () => {
  it("never loads typescript", async () => {
    const urls = await modulesOf("production", exampleDir, {});
    // The recording works: the server, its generated schema and graphql were resolved.
    expect(urls.some((url) => url.endsWith("/src/server.ts"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/src/generated/schema.ts"))).toBe(true);
    expect(urls.some((url) => url.includes("/node_modules/graphql/"))).toBe(true);
    expect(urls.filter(isTypescript)).toEqual([]);
    expect(urls.filter(isDevEntry)).toEqual([]);
  });

  it("differs from a dev boot, which loads both", async () => {
    // Without --watch-path, on a copy (the boot step may write src/generated/).
    const app = copyApp();
    try {
      const urls = await modulesOf("dev", app.dir, { GRATS_DEV: "1" });
      expect(urls.some(isTypescript)).toBe(true);
      expect(urls.some(isDevEntry)).toBe(true);
    } finally {
      app.remove();
    }
  });
});
