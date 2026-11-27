// The install test (docs/plan.html F7): the packed tarballs, installed with npm into a new
// project outside the workspace, and run there. It is not part of `pnpm check`; CI's pack-check
// jobs run it on the tarballs that
//
//   pnpm --filter "./packages/*" pack --pack-destination <dir>
//
// writes, and `pnpm run release` runs it on the ones that
//
//   changeset pack --out-dir <dir>
//
// writes, which are the ones `changeset publish --from-pack-dir <dir>` then publishes:
//
//   node scripts/install-test.ts <dir> --peers min|newest|core [--keep]
//
// A <dir> that holds a publish-plan.json is a `changeset pack` output: the test takes the
// tarballs that plan publishes, checks each one's integrity against the plan, and passes with
// nothing to test when the plan publishes nothing (every version is already on the registry).
// Any other <dir> holds the two tarballs.
//
// --peers picks what the project installs beside the tarballs:
//   min     both tarballs, and each peer at the catalog's pin, the minimum its range allows
//   newest  both tarballs, and each peer at the newest version its range allows
//   core    @dblechoc/gratos-server and graphql only: no effect, no graphql-jit, no typescript
//
// It first inspects the tarballs (their manifests, their contents, the vendored llm-docs), then
// runs the CLI, tsc, the server and its entries, and the dev boot step in the project, recording
// every module each process loads. It uses only Node's built-ins, plus npm and the project's own
// tsc. The project is deleted unless the test fails or --keep is passed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const root = join(import.meta.dirname, "..");

const COMPILER = "@dblechoc/gratos";
const SERVER = "@dblechoc/gratos-server";

/** The peers the project installs in `min` and `newest`: every peer of either package. */
const PEERS = ["effect", "@effect/platform-node", "graphql", "graphql-jit"] as const;

const MODES = ["min", "newest", "core"] as const;
type Mode = (typeof MODES)[number];

const isMode = (value: string): value is Mode => MODES.some((mode) => mode === value);

const log = (line: string): void => {
  process.stdout.write(`install-test: ${line}\n`);
};

const failures: Array<string> = [];

/**
 * Records an expectation; a failed one does not stop the test, so one run reports every failure.
 * `detail` (a process's output, the offending files) is printed only on failure.
 */
const expect = (ok: boolean, message: string, detail = ""): void => {
  if (ok) {
    log(`ok   ${message}`);
    return;
  }
  log(`FAIL ${message}`);
  if (detail.trim() !== "") {
    process.stdout.write(`${detail.trim()}\n`);
  }
  failures.push(message);
};

const stop = (message: string): never => {
  process.stderr.write(`install-test: ${message}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------------------------------------
// JSON, read without casts (Node's built-ins only, so no effect Schema or Predicate here).

type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

const isRecord = (value: Json | undefined): value is { readonly [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordAt = (value: Json | undefined, key: string): { readonly [key: string]: Json } => {
  const field = isRecord(value) ? value[key] : undefined;
  return isRecord(field) ? field : {};
};

const stringAt = (value: Json | undefined, key: string): string | undefined => {
  const field = isRecord(value) ? value[key] : undefined;
  return typeof field === "string" ? field : undefined;
};

/** A parsed JSON value, rebuilt with its type. */
const toJson = (value: unknown): Json => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((element: unknown) => toJson(element));
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, toJson(inner)]));
  }
  return null;
};

const parseJson = (text: string): Json => toJson(JSON.parse(text));

// ---------------------------------------------------------------------------------------------
// The tarballs.

/** A NUL-terminated field of a tar header. */
const text = (block: Buffer, start: number, length: number): string => {
  const raw = block.subarray(start, start + length).toString("utf8");
  const end = raw.indexOf("\0");
  return end === -1 ? raw : raw.slice(0, end);
};

/** The files of a .tgz, by path below `package/`. Regular files only. */
const readTarball = (file: string): ReadonlyMap<string, Buffer> => {
  const tar = gunzipSync(readFileSync(file));
  const files = new Map<string, Buffer>();
  let longName: string | undefined;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const size = Number.parseInt(text(header, 124, 12).trim() || "0", 8);
    const type = text(header, 156, 1);
    const name = text(header, 0, 100);
    const prefix = text(header, 345, 155);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      // A pax header: its `path` record names the next entry.
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1] ?? longName;
      continue;
    }
    if (type === "L") {
      longName = text(body, 0, body.length);
      continue;
    }
    const path = longName ?? (prefix === "" ? name : `${prefix}/${name}`);
    longName = undefined;
    if ((type === "0" || type === "") && path.startsWith("package/")) {
      files.set(path.slice("package/".length), Buffer.from(body));
    }
  }
  return files;
};

/** Every file below `dir`, by path relative to it with `/` separators. */
const walk = (dir: string, prefix = ""): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? walk(join(dir, entry.name), path) : [path];
  });

/** Every string an `exports` (or `imports`) value can resolve to, with its condition. */
const targetsOf = (value: Json, condition = "default"): ReadonlyArray<[string, string]> => {
  if (typeof value === "string") {
    return [[condition, value]];
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, inner]) =>
      targetsOf(inner, key.startsWith(".") || key.startsWith("#") ? condition : key),
    );
  }
  return [];
};

interface Packed {
  readonly name: string;
  readonly file: string;
  readonly manifest: Json;
  readonly files: ReadonlyMap<string, Buffer>;
}

const CARET_RANGE = /^\^(\d+\.\d+\.\d+)$/;

/** Each package's peers, and whether each one is optional. */
const EXPECTED_PEERS = new Map([
  ["@dblechoc/gratos", { effect: false, "@effect/platform-node": false, graphql: false }],
  ["@dblechoc/gratos-server", { graphql: false, effect: true, "graphql-jit": true }],
]);

/** The catalog's exact pin of `name`, from pnpm-workspace.yaml. */
const catalogVersion = (name: string): string => {
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const version = new RegExp(`^  "?${escaped}"?: (\\S+)$`, "m").exec(workspace)?.[1];
  return version ?? stop(`${name} has no catalog: entry in pnpm-workspace.yaml`);
};

const inspect = (packed: Packed): void => {
  const { name, manifest, files } = packed;
  const text = files.get("package.json")?.toString("utf8") ?? "";
  expect(text !== "", `${name}: the tarball has a package.json`);
  expect(
    !text.includes("catalog:") && !text.includes("workspace:"),
    `${name}: the manifest has no catalog: or workspace: specifier`,
  );
  expect(
    !isRecord(manifest) || !Object.hasOwn(manifest, "private"),
    `${name}: the manifest has no private field`,
  );

  const peers = Object.entries(recordAt(manifest, "peerDependencies"));
  // Exactly the peers each package declares, and which of them are optional: a dropped peer
  // would pass the checks below, since the fixture installs it anyway.
  const expectedPeers = EXPECTED_PEERS.get(name) ?? {};
  expect(
    JSON.stringify(peers.map(([peer]) => peer).toSorted()) ===
      JSON.stringify(Object.keys(expectedPeers).toSorted()),
    `${name}: the peers are exactly ${Object.keys(expectedPeers).join(", ")}`,
    JSON.stringify(peers.map(([peer]) => peer)),
  );
  const meta = recordAt(manifest, "peerDependenciesMeta");
  for (const [peer, optional] of Object.entries(expectedPeers)) {
    const flag = isRecord(meta[peer]) ? meta[peer]["optional"] === true : false;
    expect(flag === optional, `${name}: the peer ${peer} is ${optional ? "optional" : "required"}`);
  }
  for (const [peer, range] of peers) {
    const minimum = typeof range === "string" ? CARET_RANGE.exec(range)?.[1] : undefined;
    expect(minimum !== undefined, `${name}: the peer ${peer} is a caret range (${String(range)})`);
    if (minimum !== undefined) {
      expect(
        minimum === catalogVersion(peer),
        `${name}: the peer ${peer}'s minimum ${minimum} is the catalog's pin, which --peers min installs`,
      );
    }
  }

  const inDist = (target: string) =>
    target.startsWith("./dist/") && files.has(posix.normalize(target));
  for (const [condition, target] of targetsOf(recordAt(manifest, "exports"))) {
    expect(inDist(target), `${name}: exports (${condition}) ${target} is in the tarball's dist/`);
  }
  expect(
    targetsOf(recordAt(manifest, "exports")).some(([condition]) => condition === "types"),
    `${name}: exports declare types`,
  );
  for (const [, target] of targetsOf(recordAt(manifest, "imports"))) {
    expect(inDist(target), `${name}: imports ${target} is in the tarball's dist/`);
  }
  for (const [bin, target] of Object.entries(recordAt(manifest, "bin"))) {
    expect(
      typeof target === "string" && inDist(target),
      `${name}: bin ${bin} (${String(target)}) is in the tarball's dist/`,
    );
  }

  const listed = (() => {
    const field = isRecord(manifest) ? manifest["files"] : undefined;
    return Array.isArray(field) ? field.filter((entry) => typeof entry === "string") : [];
  })();
  const covered = (path: string) =>
    path === "package.json" ||
    listed.some((entry) => path === entry || path.startsWith(`${entry}/`));
  const stray = [...files.keys()].filter((path) => !covered(path));
  expect(stray.length === 0, `${name}: only the files entries are packed`, stray.join("\n"));
  for (const entry of listed) {
    expect(
      [...files.keys()].some((path) => path === entry || path.startsWith(`${entry}/`)),
      `${name}: the files entry ${entry} is packed`,
    );
  }
};

const inspectCompiler = (packed: Packed): void => {
  const { name, manifest, files } = packed;
  expect(
    stringAt(recordAt(manifest, "imports"), "#typescript") === "./dist/ts/index.js",
    `${name}: imports["#typescript"] is ./dist/ts/index.js`,
  );
  for (const declaration of ["dist/index.d.ts", "dist/devApi.d.ts", "dist/upstream/Types.d.ts"]) {
    expect(files.has(declaration), `${name}: ${declaration} is packed`);
  }
  const declarations = [...files.keys()].filter((path) => path.endsWith(".d.ts"));
  expect(
    declarations.length === 3,
    `${name}: no other declaration is packed`,
    declarations.join("\n"),
  );
  const cli = files.get("dist/cli.js")?.toString("utf8") ?? "";
  expect(
    cli.includes('from "../package.json"') &&
      posix.join(posix.dirname("dist/cli.js"), "../package.json") === "package.json",
    `${name}: dist/cli.js reads ../package.json, the manifest at the package root`,
  );
  expect(
    [...files.keys()].every(
      (path) => !path.startsWith("dist/") || !path.endsWith(".ts") || path.endsWith(".d.ts"),
    ),
    `${name}: dist/ holds no TypeScript source`,
  );
  expect(!files.has("dist/ts/ts5.js"), `${name}: the TypeScript 5.9.2 facade is not packed`);

  const docs = join(root, "packages", "gratos", "llm-docs");
  const repoDocs = walk(docs).toSorted();
  const packedDocs = [...files.keys()]
    .flatMap((path) => (path.startsWith("llm-docs/") ? [path.slice("llm-docs/".length)] : []))
    .toSorted();
  expect(
    JSON.stringify(repoDocs) === JSON.stringify(packedDocs),
    `${name}: llm-docs holds the repo's ${repoDocs.length} files, no more`,
  );
  const differing = repoDocs.filter(
    (path) => !files.get(`llm-docs/${path}`)?.equals(readFileSync(join(docs, path))),
  );
  expect(
    differing.length === 0,
    `${name}: llm-docs is byte-identical to the repo's`,
    differing.join("\n"),
  );
};

// ---------------------------------------------------------------------------------------------
// The project.

/** The environment of every process the test starts: the caller's, minus what would steer it. */
const cleanEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.toLowerCase().startsWith("npm_") &&
        !["NODE_OPTIONS", "GRATS_DEV", "INIT_CWD", "PNPM_HOME"].includes(key),
    ),
  );

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const run = (cwd: string, command: string, args: ReadonlyArray<string>, env = {}): Run => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...cleanEnv(), ...env },
    timeout: 600_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const show = (result: Run): string =>
  [result.stdout.trim(), result.stderr.trim()].filter((part) => part !== "").join("\n");

/** The preload that records the URL of every module a process resolves, one file per process. */
const RECORDER = `import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";

const urls = new Set();
registerHooks({
  resolve: (specifier, context, nextResolve) => {
    const result = nextResolve(specifier, context);
    urls.add(result.url);
    return result;
  },
});
process.on("exit", () => {
  const dir = process.env.GRATOS_RECORD_DIR;
  if (dir !== undefined) {
    writeFileSync(join(dir, String(process.pid) + ".json"), JSON.stringify([...urls]));
  }
});
`;

const TSCONFIG = {
  compilerOptions: {
    target: "esnext",
    lib: ["esnext"],
    module: "nodenext",
    moduleResolution: "nodenext",
    types: ["node"],
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    erasableSyntaxOnly: true,
  },
  include: ["src/**/*.ts"],
  grats: {
    graphqlSchema: "./src/generated/schema.graphql",
    tsSchema: "./src/generated/schema.ts",
    importModuleSpecifierEnding: ".ts",
  },
};

const MODELS = `import type { Float, GqlInfo, ID, Int } from "@dblechoc/gratos";
import { Effect } from "effect";

/** @gqlType */
export class Item {
  /** @gqlField */
  readonly id: ID;
  /** @gqlField */
  readonly count: Int;
  /** @gqlField */
  readonly price: Float;

  constructor(id: ID, count: Int, price: Float) {
    this.id = id;
    this.count = count;
    this.price = price;
  }
}

/** @gqlQueryField */
export function item(): Item {
  return new Item("1", 2, 2.5);
}

/** @gqlQueryField */
export function operation(info: GqlInfo): string {
  return info.operation.operation;
}

/** @gqlQueryField */
export function greeting(): Effect.Effect<string> {
  return Effect.succeed("hello");
}
`;

/** The app's server: the generated schema, wrapped for its Effect resolver. */
const APP = `import { GraphQLError } from "graphql";
import type { GraphQLSchema } from "graphql";
import { createServer } from "@dblechoc/gratos-server";
import type { Server } from "@dblechoc/gratos-server";
import { effect, effectSchema } from "@dblechoc/gratos-server/effect";

export const QUERY = "{ item { id count price } operation greeting }";

export const makeServer = (schema: GraphQLSchema): Server =>
  createServer({
    schema: effectSchema(schema, {
      failure: (error: never) => new GraphQLError(String(error)),
      isFailure: (_error: unknown): _error is never => false,
    }),
    plugins: [effect()],
  });

export const ask = async (server: Server, query: string): Promise<string> => {
  const response = await server.handle(
    new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
  );
  return response.text();
};
`;

/** A production start: the generated schema module and the app, never the compiler. */
/** Imports a value from the compiler's root entry, so its runtime export is exercised too. */
const COMPILER_RUNTIME = `import { packageName } from "@dblechoc/gratos";

process.stdout.write(packageName);
`;

const SERVER_START = `import { ask, makeServer, QUERY } from "./app.ts";
import { getSchema } from "./generated/schema.ts";

process.stdout.write(await ask(makeServer(getSchema()), QUERY));
`;

const IMPORT_SERVER = `import { createServer } from "@dblechoc/gratos-server";

process.stdout.write(typeof createServer);
`;

const DEV = `import { loadSchema } from "@dblechoc/gratos/dev";
import { Result } from "effect";

import { ask, makeServer, QUERY } from "./app.ts";

const loaded = await loadSchema({
  tsconfig: new URL("../tsconfig.json", import.meta.url),
  load: () => import("./generated/schema.ts"),
  log: () => {},
});
if (Result.isFailure(loaded)) {
  process.stderr.write(loaded.failure.formatted);
  process.exit(1);
}
process.stdout.write(await ask(makeServer(loaded.success.getSchema()), QUERY));
`;

/** jit() from its own entry, past its threshold: the jit phase shows that graphql-jit ran. */
const JIT = `import { createServer } from "@dblechoc/gratos-server";
import { jit } from "@dblechoc/gratos-server/jit";

import { ask } from "./app.ts";
import { getSchema } from "./generated/schema.ts";

const phases: Array<string> = [];
const server = createServer({
  schema: getSchema(),
  plugins: [
    jit({ after: 2 }),
    {
      onPhase: (phase) => {
        phases.push(phase.name);
        return undefined;
      },
    },
  ],
});
const answers = [];
for (let use = 1; use <= 3; use += 1) {
  answers.push(JSON.parse(await ask(server, "{ item { id count price } }")));
}
process.stdout.write(JSON.stringify({ answers, phases }));
`;

/** The core with none of the optional peers: a hand-written schema, every plugin of the entry. */
const CORE = `import { buildSchema } from "graphql";
import {
  apq,
  createServer,
  incremental,
  maskErrors,
  maxDepth,
  readOnly,
  reportErrors,
  serverTiming,
} from "@dblechoc/gratos-server";

const server = createServer({
  schema: buildSchema("type Query { count: Int }"),
  rootValue: { count: 1 },
  plugins: [apq(), incremental(), maxDepth(5), readOnly(), serverTiming(), reportErrors(() => {}), maskErrors()],
});
const response = await server.handle(
  new Request("http://localhost/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ count }" }),
  }),
);
process.stdout.write(await response.text());
`;

const EXPECTED_ANSWER = {
  data: { item: { id: "1", count: 2, price: 2.5 }, operation: "query", greeting: "hello" },
};

/** The package roots (`…/node_modules/<name>`) of every loaded module of `name`. */
const copiesOf = (urls: ReadonlyArray<string>, name: string): ReadonlySet<string> => {
  const marker = `/node_modules/${name}/`;
  return new Set(
    urls.flatMap((url) => {
      const at = url.lastIndexOf(marker);
      return at === -1 ? [] : [url.slice(0, at + marker.length)];
    }),
  );
};

/** True when any module of `name` was loaded. */
const loads = (urls: ReadonlyArray<string>, name: string): boolean => copiesOf(urls, name).size > 0;

const PUBLISH_PLAN = "publish-plan.json";

/** A release a `changeset pack` publish plan publishes, with its tarball's path below the dir. */
interface PlannedRelease {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
}

/**
 * The releases `dir`'s publish-plan.json publishes, each tarball checked against the plan's
 * integrity (so the tarballs tested are the ones `changeset publish --from-pack-dir` publishes),
 * or undefined when `dir` holds no plan. The plan's tag-only releases have no tarball.
 */
const publishPlan = (dir: string): ReadonlyArray<PlannedRelease> | undefined => {
  const file = join(dir, PUBLISH_PLAN);
  if (!existsSync(file)) {
    return undefined;
  }
  const plan = parseJson(readFileSync(file, "utf8"));
  const version = isRecord(plan) ? plan["version"] : undefined;
  const chunks = isRecord(plan) ? plan["plan"] : undefined;
  if (version !== 1 || !Array.isArray(chunks)) {
    return stop(`${file} is not a version 1 publish plan`);
  }
  return chunks.flat().flatMap((release: Json): ReadonlyArray<PlannedRelease> => {
    if (stringAt(release, "kind") !== "publish") {
      return [];
    }
    const name = stringAt(release, "name") ?? stop(`${file} has a release with no name`);
    const tarball = recordAt(release, "tarball");
    const path = stringAt(tarball, "path") ?? stop(`${file} has no tarball for ${name}`);
    const integrity =
      stringAt(tarball, "integrity") ?? stop(`${file} has no integrity for ${name}`);
    const actual = `sha256-${createHash("sha256")
      .update(readFileSync(join(dir, path)))
      .digest("base64")}`;
    if (actual !== integrity) {
      return stop(
        `${path} is not the tarball ${file} names (integrity ${actual}, not ${integrity})`,
      );
    }
    return [{ name, version: stringAt(release, "version") ?? "", tarball: path }];
  });
};

const main = (): void => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { peers: { type: "string" }, keep: { type: "boolean", default: false } },
  });
  const [tarballDir] = positionals;
  const mode = values.peers;
  if (tarballDir === undefined || mode === undefined || !isMode(mode) || positionals.length > 1) {
    return stop(
      "usage: node scripts/install-test.ts <tarball-dir> --peers min|newest|core [--keep]",
    );
  }

  // The tarballs, by package name.
  const dir = resolve(tarballDir);
  const planned = publishPlan(dir);
  if (planned !== undefined && planned.length === 0) {
    log(`${join(dir, PUBLISH_PLAN)} publishes nothing: there is nothing to test`);
    return;
  }
  const tarballs =
    planned?.map((release) => release.tarball) ??
    readdirSync(dir).filter((file) => file.endsWith(".tgz"));
  const packed = new Map<string, Packed>();
  for (const tarball of tarballs) {
    const file = join(dir, tarball);
    const files = readTarball(file);
    const manifest = parseJson(files.get("package.json")?.toString("utf8") ?? "null");
    const name = stringAt(manifest, "name") ?? stop(`${tarball} has no package name`);
    packed.set(name, { name, file, manifest, files });
  }
  for (const release of planned ?? []) {
    const manifest = packed.get(release.name)?.manifest;
    expect(
      manifest !== undefined && stringAt(manifest, "version") === release.version,
      `${release.tarball} is ${release.name}@${release.version}, as the publish plan says`,
    );
  }
  const compiler = packed.get(COMPILER) ?? stop(`no ${COMPILER} tarball in ${dir}`);
  const server = packed.get(SERVER) ?? stop(`no ${SERVER} tarball in ${dir}`);
  expect(packed.size === 2, `${dir} holds the two tarballs only`, tarballs.join("\n"));

  log("inspecting the tarballs");
  inspect(compiler);
  inspectCompiler(compiler);
  inspect(server);
  const version = stringAt(compiler.manifest, "version") ?? "";

  // The project, outside the workspace.
  const project = mkdtempSync(join(realpathSync(tmpdir()), "gratos-install-test-"));
  expect(
    relative(root, project).startsWith(".."),
    `the project ${project} is outside the workspace`,
  );
  const peerRange = (name: string): string =>
    stringAt(recordAt(compiler.manifest, "peerDependencies"), name) ??
    stringAt(recordAt(server.manifest, "peerDependencies"), name) ??
    stop(`no package has ${name} as a peer`);
  const spec = (name: string): string =>
    mode === "newest" ? peerRange(name) : catalogVersion(name);
  const dependencies: Record<string, string> =
    mode === "core"
      ? { [SERVER]: `file:${server.file}`, graphql: spec("graphql") }
      : {
          [COMPILER]: `file:${compiler.file}`,
          [SERVER]: `file:${server.file}`,
          ...Object.fromEntries(PEERS.map((name) => [name, spec(name)])),
        };
  const devDependencies: Record<string, string> =
    mode === "core"
      ? {}
      : mode === "newest"
        ? {
            typescript: `^${catalogVersion("typescript")}`,
            "@types/node": `^${catalogVersion("@types/node")}`,
          }
        : {
            typescript: catalogVersion("typescript"),
            "@types/node": catalogVersion("@types/node"),
          };
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify(
      { name: "gratos-install-test", private: true, type: "module", dependencies, devDependencies },
      null,
      2,
    )}\n`,
  );
  log(`installing in ${project} (--peers ${mode})`);
  const install = run(project, "npm", ["install", "--no-audit", "--no-fund"]);
  if (install.status !== 0) {
    return stop(`npm install failed:\n${show(install)}`);
  }
  const installed = (name: string): string | undefined => {
    const file = join(project, "node_modules", name, "package.json");
    return existsSync(file)
      ? stringAt(parseJson(readFileSync(file, "utf8")), "version")
      : undefined;
  };
  for (const name of [COMPILER, SERVER, ...PEERS, "typescript", "@types/node"]) {
    log(`installed ${name}@${installed(name) ?? "(none)"}`);
  }
  if (mode === "min") {
    for (const name of PEERS) {
      expect(
        installed(name) === catalogVersion(name),
        `${name} is the catalog's ${catalogVersion(name)}`,
      );
    }
  }

  // gratos writes into src/generated/ but, as Grats, does not create it.
  mkdirSync(join(project, "src", "generated"), { recursive: true });
  const recorder = join(project, "record.mjs");
  writeFileSync(recorder, RECORDER);
  const write = (file: string, content: string) => writeFileSync(join(project, file), content);

  /** Runs `args` with the recorder preloaded; returns the run and every module it loaded. */
  const traced = (label: string, command: string, args: ReadonlyArray<string>) => {
    const records = join(project, ".records", label);
    mkdirSync(records, { recursive: true });
    const result = run(project, command, args, {
      NODE_OPTIONS: `--import=${pathToFileURL(recorder).href}`,
      GRATOS_RECORD_DIR: records,
    });
    const urls = readdirSync(records).flatMap((file) => {
      const list = parseJson(readFileSync(join(records, file), "utf8"));
      return Array.isArray(list) ? list.filter((url) => typeof url === "string") : [];
    });
    return { result, urls };
  };

  if (mode === "core") {
    for (const name of ["effect", "graphql-jit", "typescript", COMPILER]) {
      expect(installed(name) === undefined, `${name} is not installed`);
    }
    write("src/core.ts", CORE);
    const core = traced("core", process.execPath, ["src/core.ts"]);
    expect(
      core.result.status === 0 && core.result.stdout === JSON.stringify({ data: { count: 1 } }),
      `the core answers a query with none of the optional peers`,
      show(core.result),
    );
    expect(!loads(core.urls, "effect"), "the core loads no effect");
    expect(!loads(core.urls, "graphql-jit"), "the core loads no graphql-jit");
    expect(copiesOf(core.urls, "graphql").size === 1, "the core loads one copy of graphql");
  } else {
    write("tsconfig.json", `${JSON.stringify(TSCONFIG, null, 2)}\n`);
    write("src/models.ts", MODELS);
    write("src/app.ts", APP);
    write("src/server.ts", SERVER_START);
    write("src/importServer.ts", IMPORT_SERVER);
    write("src/dev.ts", DEV);
    write("src/jit.ts", JIT);

    // The CLI.
    const printed = run(project, "npx", ["--no", "--", "gratos", "--version"]);
    expect(
      printed.status === 0 && printed.stdout === `gratos v${version}\n`,
      `npx gratos --version prints gratos v${version}`,
      show(printed),
    );
    const generated = traced("cli", "npx", ["--no", "--", "gratos"]);
    expect(
      generated.result.status === 0,
      `npx gratos generates the schema`,
      show(generated.result),
    );
    const sdl = (() => {
      try {
        return readFileSync(join(project, "src", "generated", "schema.graphql"), "utf8");
      } catch {
        return "";
      }
    })();
    const ts = (() => {
      try {
        return readFileSync(join(project, "src", "generated", "schema.ts"), "utf8");
      } catch {
        return "";
      }
    })();
    for (const [field, scalar] of [
      ["id", "ID"],
      ["count", "Int"],
      ["price", "Float"],
    ]) {
      expect(
        new RegExp(`^  ${field}: ${scalar}!?$`, "m").test(sdl),
        `the schema types Item.${field} as ${scalar}, read from the installed declarations`,
      );
    }
    expect(
      /^ {2}operation: String!?$/m.test(sdl),
      "the GqlInfo argument is not a GraphQL argument",
    );
    expect(
      ["GraphQLID", "GraphQLInt", "GraphQLFloat"].every((scalar) => ts.includes(scalar)),
      "the TypeScript schema uses graphql's ID, Int and Float",
    );
    expect(
      generated.urls.some((url) => url.includes(`/node_modules/${COMPILER}/dist/cli.js`)),
      "the CLI that ran is the installed dist/cli.js",
    );
    expect(
      !generated.urls.some((url) => url.includes("typescript-baseline")),
      "the installed CLI never loads typescript-baseline",
    );

    // Types, with a stock TypeScript 7 and no skipLibCheck.
    const tsc = run(project, join(project, "node_modules", ".bin", "tsc"), [
      "--noEmit",
      "-p",
      "tsconfig.json",
    ]);
    const tscVersion = run(project, join(project, "node_modules", ".bin", "tsc"), ["--version"]);
    expect(
      tsc.status === 0,
      `tsc --noEmit passes with skipLibCheck: false (${tscVersion.stdout.trim()})`,
      show(tsc),
    );

    // The compiler's root entry at run time, not only for types.
    write("src/runtime.ts", COMPILER_RUNTIME);
    const runtime = run(project, process.execPath, ["src/runtime.ts"]);
    expect(
      runtime.status === 0 && runtime.stdout === COMPILER,
      `the compiler's root entry runs: packageName is ${COMPILER}`,
      show(runtime),
    );

    // The core entry alone.
    const imported = traced("import", process.execPath, ["src/importServer.ts"]);
    expect(imported.result.stdout === "function", `${SERVER} imports`, show(imported.result));
    expect(!loads(imported.urls, "graphql-jit"), `importing ${SERVER} loads no graphql-jit`);
    expect(!loads(imported.urls, "effect"), `importing ${SERVER} loads no effect`);

    // A production start of the server, with the Effect layer.
    const started = traced("server", process.execPath, ["src/server.ts"]);
    expect(
      started.result.status === 0 && started.result.stdout === JSON.stringify(EXPECTED_ANSWER),
      `the server from ${SERVER} and /effect answers a query`,
      show(started.result),
    );
    expect(!loads(started.urls, "typescript"), "a production start never loads typescript");
    expect(!loads(started.urls, COMPILER), `a production start never loads ${COMPILER}`);
    expect(copiesOf(started.urls, "effect").size === 1, "the server loads one copy of effect");
    expect(copiesOf(started.urls, "graphql").size === 1, "the server loads one copy of graphql");

    // jit() from /jit, past its threshold.
    const jitted = traced("jit", process.execPath, ["src/jit.ts"]);
    const jitOutput = (() => {
      try {
        return parseJson(jitted.result.stdout);
      } catch {
        return null;
      }
    })();
    const answers = isRecord(jitOutput) ? jitOutput["answers"] : undefined;
    const phases = isRecord(jitOutput) ? jitOutput["phases"] : undefined;
    const item = { data: { item: EXPECTED_ANSWER.data.item } };
    expect(
      jitted.result.status === 0 &&
        Array.isArray(answers) &&
        answers.length === 3 &&
        answers.every((answer) => JSON.stringify(answer) === JSON.stringify(item)),
      `jit() from /jit answers three times`,
      show(jitted.result),
    );
    expect(
      Array.isArray(phases) && phases.includes("jit"),
      `jit() compiled the query past its threshold (phases ${JSON.stringify(phases)})`,
    );
    expect(
      [...copiesOf(jitted.urls, "graphql-jit")].every((copy) =>
        copy.startsWith(pathToFileURL(project).href),
      ) && loads(jitted.urls, "graphql-jit"),
      "jit() runs the project's graphql-jit",
    );

    // The dev boot step, from scratch: it regenerates the schema the CLI wrote.
    const cliSchema = ts;
    for (const file of ["schema.ts", "schema.graphql"]) {
      rmSync(join(project, "src", "generated", file), { force: true });
    }
    const booted = traced("dev", process.execPath, ["src/dev.ts"]);
    expect(
      booted.result.status === 0 && booted.result.stdout === JSON.stringify(EXPECTED_ANSWER),
      `${COMPILER}/dev boots once and its schema answers`,
      show(booted.result),
    );
    expect(
      existsSync(join(project, "src", "generated", "schema.ts")) &&
        readFileSync(join(project, "src", "generated", "schema.ts"), "utf8") === cliSchema,
      "the boot step writes the schema the CLI wrote",
    );
    expect(copiesOf(booted.urls, "effect").size === 1, "/dev loads one copy of effect");
    expect(copiesOf(booted.urls, "graphql").size === 1, "/dev loads one copy of graphql");
    expect(
      !booted.urls.some((url) => url.includes("typescript-baseline")),
      "/dev never loads typescript-baseline",
    );
  }

  if (failures.length > 0) {
    log(`${failures.length} failed (the project is kept: ${project}):`);
    for (const failure of failures) {
      log(`  ${failure}`);
    }
    process.exit(1);
  }
  if (values.keep) {
    log(`passed (--peers ${mode}); the project is kept: ${project}`);
  } else {
    rmSync(project, { recursive: true, force: true });
    log(`passed (--peers ${mode})`);
  }
};

main();
