// The dev boot step (src/dev.ts, docs/plan.html M6) on a copy of the smoke fixture: it writes
// only the generated files that changed, loads the schema module only once they are written,
// and turns every failure into a GratsDevError that answers 500 GRATS_ERROR with the
// diagnostics. The `pnpm dev` loop itself is tested on the real process in examples/orders.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Result } from "effect";

import { devSchema, GRATS_ERROR, loadSchema } from "../src/dev.ts";
import { smokeCopy } from "./support/scratch.ts";

const committedTs = readFileSync(join(import.meta.dirname, "smoke", "schema.ts"), "utf8");

const silent = () => {
  const lines: Array<string> = [];
  return { lines, log: (line: string) => void lines.push(line) };
};

describe("devSchema", () => {
  it.effect("writes the schema, then loads it", () => {
    const project = smokeCopy("dev-writes");
    const { lines, log } = silent();
    return Effect.gen(function* () {
      const written: Array<string> = [];
      const loaded = yield* devSchema({
        tsconfig: pathToFileURL(project.path("tsconfig.json")),
        load: async () => {
          // Called once the files are written.
          written.push(readFileSync(project.path("schema.ts"), "utf8"));
          return "the module";
        },
        log,
      });
      expect(loaded).toBe("the module");
      expect(written).toEqual([committedTs]);
      expect(lines).toEqual([
        expect.stringMatching(/^Gratos: wrote schema\.graphql, schema\.ts \(\d+ ms\)\.$/),
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.ensuring(Effect.sync(project.remove)));
  });

  it.effect("does not rewrite files that are up to date", () => {
    const project = smokeCopy("dev-unchanged");
    const { lines, log } = silent();
    return Effect.gen(function* () {
      const options = { tsconfig: project.path("tsconfig.json"), load: async () => 1, log };
      yield* devSchema(options);
      const past = new Date("2026-01-01T00:00:00.000Z");
      utimesSync(project.path("schema.ts"), past, past);
      yield* devSchema(options);
      expect(statSync(project.path("schema.ts")).mtime).toEqual(past);
      expect(lines[1]).toMatch(/^Gratos: the schema is up to date \(\d+ ms\)\.$/);
    }).pipe(Effect.provide(NodeServices.layer), Effect.ensuring(Effect.sync(project.remove)));
  });

  it.effect("fails with the diagnostics, and never loads, when the models do not build", () => {
    const project = smokeCopy("dev-broken");
    project.write(
      "models/Order.ts",
      readFileSync(project.path("models/Order.ts"), "utf8").replace(
        "  quantity: Int;",
        "  quantity: Map<string, Int>;",
      ),
    );
    const { lines, log } = silent();
    let loads = 0;
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        devSchema({
          tsconfig: project.path("tsconfig.json"),
          load: async () => {
            loads += 1;
          },
          log,
        }),
      );
      expect(loads).toBe(0);
      expect(error._tag).toBe("GratsDevError");
      expect(error.message).toMatch(
        /^Gratos could not build the schema: Unable to resolve type reference\./,
      );
      const [diagnostic] = error.diagnostics;
      expect(error.diagnostics).toHaveLength(1);
      expect(diagnostic).toMatchObject({ line: 10, column: 13 });
      // Relative to the current directory, as the terminal prints it.
      expect(diagnostic?.file).toMatch(/^test\/\.scratch\/dev-broken-\w+\/models\/Order\.ts$/);
      // The terminal gets the diagnostics with their source context.
      expect(lines[0]).toContain("quantity: Map<string, Int>;");
      expect(lines[1]).toMatch(
        /^Gratos: every request answers 500 GRATS_ERROR until the next good save/,
      );

      const response = error.response();
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe(
        "application/graphql-response+json; charset=utf-8",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.promise(() => response.json())).toEqual({
        errors: [
          {
            message: error.message,
            extensions: { code: GRATS_ERROR, diagnostics: error.diagnostics },
          },
        ],
      });
      // A new Response each time: a body can be read only once.
      expect(error.response()).not.toBe(response);
      expect(error.response().bodyUsed).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.ensuring(Effect.sync(project.remove)));
  });

  it.effect("fails with a GratsDevError when the schema module cannot be loaded", () => {
    const project = smokeCopy("dev-load");
    const { log } = silent();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        devSchema({
          tsconfig: project.path("tsconfig.json"),
          load: () => Promise.reject(new SyntaxError("Unexpected token")),
          log,
        }),
      );
      expect(error.message).toBe("Gratos could not load the app: SyntaxError: Unexpected token");
      expect(error.diagnostics).toEqual([{ message: "SyntaxError: Unexpected token" }]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.ensuring(Effect.sync(project.remove)));
  });

  it.effect("points a load error at the file and line Node reports", () => {
    const project = smokeCopy("dev-load-syntax");
    // Outside the tsconfig's include: only loading it fails, as with an app's service.
    project.write("services/Bus.ts", "export const bus = make(;\n");
    // Node's own error (vitest's import() would go through Vite): the stack of a real import.
    const imported = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "try { await import(process.argv[1]); } catch (e) { process.stdout.write(e.stack); }",
        pathToFileURL(project.path("services/Bus.ts")).href,
      ],
      { encoding: "utf8" },
    );
    const nodeError = new SyntaxError("Expression expected");
    nodeError.name = "SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]";
    nodeError.stack = imported.stdout;
    const { lines, log } = silent();
    return Effect.gen(function* () {
      expect(imported.stdout).toMatch(/^(?:file:\/\/)?\/.*\/services\/Bus\.ts:1\n/);
      const error = yield* Effect.flip(
        devSchema({
          tsconfig: project.path("tsconfig.json"),
          load: () => Promise.reject(nodeError),
          log,
        }),
      );
      expect(error.message).toBe(
        "Gratos could not load the app: SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expression expected",
      );
      expect(error.diagnostics).toEqual([
        {
          message: "SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expression expected",
          file: expect.stringMatching(/^test\/\.scratch\/dev-load-syntax-\w+\/services\/Bus\.ts$/),
          line: 1,
        },
      ]);
      // The terminal gets Node's own report: where, the source line and the caret.
      expect(error.formatted).toContain("export const bus = make(;\n");
      expect(lines[0]).toBe(error.formatted);
    }).pipe(Effect.provide(NodeServices.layer), Effect.ensuring(Effect.sync(project.remove)));
  });

  it.effect("fails with a GratsDevError when the tsconfig is missing", () => {
    const { log } = silent();
    return Effect.gen(function* () {
      const missing = join(import.meta.dirname, "missing", "tsconfig.json");
      const error = yield* Effect.flip(devSchema({ tsconfig: missing, load: async () => 1, log }));
      expect(error.diagnostics).toEqual([{ message: error.message }]);
      expect(error.message).toContain("Could not read");
    }).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("turns a defect into a GratsDevError", () => {
    const { log } = silent();
    return Effect.gen(function* () {
      // Not a file URL: reading its path throws inside the boot step, a defect.
      const error = yield* Effect.flip(
        devSchema({
          tsconfig: new URL("http://example.test/tsconfig.json"),
          load: async () => 1,
          log,
        }),
      );
      expect(error.message).toBe("Gratos failed unexpectedly while building the schema.");
      expect(error.diagnostics[0]?.message).toContain("file");
    }).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("keeps a loaded app when the logger throws on the success line", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    return Effect.gen(function* () {
      const loaded = yield* devSchema({
        tsconfig: join(import.meta.dirname, "smoke", "tsconfig.json"),
        load: async () => "the app",
        log: (line) => {
          if (line.startsWith("Gratos: the schema") || line.startsWith("Gratos: wrote")) {
            throw new Error("boom");
          }
        },
      });
      expect(loaded).toBe("the app");
      // The line still reaches the terminal.
      expect(stderr.mock.calls.map(([line]) => String(line)).join("\n")).toMatch(
        /Gratos: (the schema|wrote)/,
      );
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => stderr.mockRestore())),
    );
  });

  it.effect("keeps Node's load error when its stack names a file URL that does not decode", () =>
    Effect.gen(function* () {
      const cause = new SyntaxError("Unexpected token");
      cause.stack =
        "file:///tmp/100%.js:1\nconst x = ;\n          ^\n\nSyntaxError: Unexpected token";
      const error = yield* Effect.flip(
        devSchema({
          tsconfig: join(import.meta.dirname, "smoke", "tsconfig.json"),
          load: () => Promise.reject(cause),
          log: () => {},
        }),
      );
      expect(error.message).toBe("Gratos could not load the app: SyntaxError: Unexpected token");
      expect(error.diagnostics).toEqual([{ message: "SyntaxError: Unexpected token" }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const throwing = (line: string) => {
  throw new Error(`the logger is broken (${line.slice(0, 20)})`);
};

describe("devSchema's error report", () => {
  it.effect("keeps the original GratsDevError when the logger throws", () =>
    Effect.gen(function* () {
      const missing = join(import.meta.dirname, "missing", "tsconfig.json");
      const error = yield* Effect.flip(
        devSchema({ tsconfig: missing, load: async () => 1, log: throwing }),
      );
      expect(error._tag).toBe("GratsDevError");
      expect(error.message).toContain("Could not read");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("resolves loadSchema with the original GratsDevError when the logger throws", async () => {
    const project = smokeCopy("dev-logger");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bad = await loadSchema({
        tsconfig: project.path("tsconfig.json"),
        load: () => Promise.reject(new SyntaxError("Unexpected token")),
        log: throwing,
      });
      assert(Result.isFailure(bad));
      expect(bad.failure.message).toBe(
        "Gratos could not load the app: SyntaxError: Unexpected token",
      );
      // The terminal still gets the error, on standard error.
      expect(stderr.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
        bad.failure.formatted,
      );
    } finally {
      stderr.mockRestore();
      project.remove();
    }
  });
});

describe("the dev log's fallback", () => {
  it("survives a closed stderr when the caller's logger throws (no EPIPE crash)", async () => {
    const project = smokeCopy("dev-epipe");
    try {
      const script = [
        `import { loadSchema } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "src", "dev.ts")).href)};`,
        `const result = await loadSchema({`,
        `  tsconfig: ${JSON.stringify(project.path("tsconfig.json"))},`,
        `  load: async () => "the app",`,
        `  log: () => { throw new Error("the logger is broken"); },`,
        `});`,
        `process.stdout.write(result._tag);`,
      ].join("\n");
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      // The reader of stderr goes away at once: a raw write to it would fail with EPIPE.
      child.stderr.destroy();
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      const [code] = await once(child, "exit");
      expect(stdout).toBe("Success");
      expect(code).toBe(0);
    } finally {
      project.remove();
    }
  }, 30_000);
});

describe("loadSchema", () => {
  it("resolves with a Result, never rejecting", async () => {
    const project = smokeCopy("dev-promise");
    try {
      const good = await loadSchema({
        tsconfig: project.path("tsconfig.json"),
        load: async () => 2,
        log: () => {},
      });
      assert.deepStrictEqual(good, Result.succeed(2));
      const bad = await loadSchema({
        tsconfig: project.path("missing.json"),
        load: async () => 2,
        log: () => {},
      });
      assert(Result.isFailure(bad));
      expect(bad.failure._tag).toBe("GratsDevError");
    } finally {
      project.remove();
    }
  });
});
