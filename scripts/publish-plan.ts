// Changesets publish plans (docs/plan.html F7, AGENTS.md "Releasing"), read with Node's built-ins
// only. Three scripts share it:
//
//   scripts/release.ts      reads the plan `changeset publish-plan --output` writes, and stops
//                           early when it publishes nothing;
//   scripts/install-test.ts reads the plan `changeset pack --out-dir <dir>` writes beside the
//                           tarballs, and tests the tarballs it names;
//   scripts/verify-pack.ts  checks that same pack output in the release workflow's test and
//                           publish jobs, before the install test tests it, and before
//                           `changeset publish --from-pack-dir <dir>` publishes it.
//
// A plan is `{ version: 1, plan: [[release, …], …] }`. Changesets publishes every release whose
// kind is not "tag-only", so a kind this file does not know is an error here, never a release
// to skip.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix, sep } from "node:path";
import { gunzipSync } from "node:zlib";

export const COMPILER = "@dblechoc/gratos";
export const SERVER = "@dblechoc/gratos-server";

/** The packages a plan may publish: the two in the `fixed` group of .changeset/config.json. */
export const PACKAGES: ReadonlyArray<string> = [COMPILER, SERVER];

export const PUBLISH_PLAN = "publish-plan.json";

// ---------------------------------------------------------------------------------------------
// JSON, read without casts (Node's built-ins only, so no effect Schema or Predicate here).

export type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

export const isRecord = (value: Json | undefined): value is { readonly [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const recordAt = (
  value: Json | undefined,
  key: string,
): { readonly [key: string]: Json } => {
  const field = isRecord(value) ? value[key] : undefined;
  return isRecord(field) ? field : {};
};

export const isArray = (value: Json | undefined): value is ReadonlyArray<Json> =>
  Array.isArray(value);

export const stringAt = (value: Json | undefined, key: string): string | undefined => {
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

export const parseJson = (text: string): Json => toJson(JSON.parse(text));

// ---------------------------------------------------------------------------------------------
// Tarballs.

/** A NUL-terminated field of a tar header. */
const field = (block: Buffer, start: number, length: number): string => {
  const raw = block.subarray(start, start + length).toString("utf8");
  const end = raw.indexOf("\0");
  return end === -1 ? raw : raw.slice(0, end);
};

/** The files of a .tgz, by path below `package/`. Regular files only. */
export const readTarball = (file: string): ReadonlyMap<string, Buffer> => {
  const tar = gunzipSync(readFileSync(file));
  const files = new Map<string, Buffer>();
  let longName: string | undefined;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = field(header, 156, 1);
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      // A pax header: its `path` record names the next entry.
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1] ?? longName;
      continue;
    }
    if (type === "L") {
      longName = field(body, 0, body.length);
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

/** A tarball's package.json, parsed (null when it has none). */
export const manifestOf = (files: ReadonlyMap<string, Buffer>): Json =>
  parseJson(files.get("package.json")?.toString("utf8") ?? "null");

/** The integrity `changeset pack` records for a file: its sha256, in base64. */
export const integrityOf = (file: string): string =>
  `sha256-${createHash("sha256").update(readFileSync(file)).digest("base64")}`;

// ---------------------------------------------------------------------------------------------
// Plans.

/** A release a plan publishes. `tarball` and `integrity` are set in a `changeset pack` output. */
export interface PlannedRelease {
  readonly name: string;
  readonly version: string;
  readonly tarball?: { readonly path: string; readonly integrity: string };
}

/** The kinds a Changesets 3 plan entry can have. */
const KINDS: ReadonlySet<string> = new Set(["publish", "tag-only"]);

/**
 * The releases `file` publishes, in order. Throws on anything that is not a version 1 plan of
 * known kinds, on a release of a package outside PACKAGES, and on a package planned twice.
 * Tag-only releases have no tarball and publish nothing, so they are left out. With `packed`, each
 * release must name its tarball and integrity, as `changeset pack` writes them.
 */
export const readPlan = (
  file: string,
  { packed }: { readonly packed: boolean },
): ReadonlyArray<PlannedRelease> => {
  const plan = parseJson(readFileSync(file, "utf8"));
  const chunks = isRecord(plan) ? plan["plan"] : undefined;
  if (!isRecord(plan) || plan["version"] !== 1 || !isArray(chunks)) {
    throw new Error(`${file} is not a version 1 publish plan`);
  }
  const releases: Array<PlannedRelease> = [];
  for (const chunk of chunks) {
    if (!isArray(chunk)) {
      throw new Error(`${file} has a plan chunk that is not an array`);
    }
    for (const release of chunk) {
      const kind = stringAt(release, "kind");
      if (kind === undefined || !KINDS.has(kind)) {
        throw new Error(`${file} has a release of unknown kind ${JSON.stringify(kind ?? null)}`);
      }
      if (kind === "tag-only") {
        continue;
      }
      const name = stringAt(release, "name");
      const version = stringAt(release, "version");
      if (name === undefined || version === undefined) {
        throw new Error(`${file} has a release with no name or version`);
      }
      if (!PACKAGES.includes(name)) {
        throw new Error(`${file} publishes ${name}, which is not ${PACKAGES.join(" or ")}`);
      }
      if (releases.some((planned) => planned.name === name)) {
        throw new Error(`${file} publishes ${name} twice`);
      }
      const tarball = recordAt(release, "tarball");
      const path = stringAt(tarball, "path");
      const integrity = stringAt(tarball, "integrity");
      if (path === undefined || integrity === undefined) {
        if (packed) {
          throw new Error(`${file} has no tarball and integrity for ${name}@${version}`);
        }
        releases.push({ name, version });
      } else {
        releases.push({ name, version, tarball: { path, integrity } });
      }
    }
  }
  return releases;
};

/** A planned release of a `changeset pack` output, with its tarball read and checked. */
export interface PackedRelease {
  readonly name: string;
  readonly version: string;
  /** The tarball's path below the pack dir, as the plan names it. */
  readonly path: string;
  /** The tarball's absolute path. */
  readonly file: string;
  readonly manifest: Json;
  readonly files: ReadonlyMap<string, Buffer>;
}

/**
 * The releases of the pack output in `dir` (its publish-plan.json and the tarballs below it), or
 * undefined when `dir` holds no plan. Throws unless every planned tarball is a `.tgz` that is a
 * regular file inside `dir` (never a symlink, nor below one: its real path is inside `dir`'s),
 * has the plan's integrity, and holds the package and version of its own plan entry, and unless
 * `dir` holds nothing else: no other file of any name (an unplanned .tgz, .tar.gz or .tar is an
 * archive Changesets could be pointed at), and no symlink. Then the tarballs read are exactly the
 * ones `changeset publish --from-pack-dir <dir>` publishes.
 */
export const readPackDir = (dir: string): ReadonlyArray<PackedRelease> | undefined => {
  const file = join(dir, PUBLISH_PLAN);
  const planStat = lstatSync(file, { throwIfNoEntry: false });
  if (planStat === undefined) {
    return undefined;
  }
  // The plan itself is a regular file too: a symlink to a file with the recorded hash elsewhere
  // would otherwise pass the hash check.
  if (!planStat.isFile()) {
    throw new Error(`${file} is not a regular file (a symlink, or a directory)`);
  }
  const realDir = realpathSync(dir);
  const packed = readPlan(file, { packed: true }).map((release): PackedRelease => {
    const { name, version } = release;
    const path = release.tarball?.path ?? "";
    const normalized = posix.normalize(path);
    if (isAbsolute(path) || normalized.startsWith("../") || normalized !== path) {
      throw new Error(`${file} names ${path} for ${name}, which is not a path below ${dir}`);
    }
    if (!path.endsWith(".tgz")) {
      throw new Error(`${file} names ${path} for ${name}, which is not a .tgz`);
    }
    const tarball = join(dir, path);
    const stat = lstatSync(tarball, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) {
      throw new Error(
        `${path}, the tarball ${file} names for ${name}, is ${stat === undefined ? "missing" : stat.isSymbolicLink() ? "a symlink" : "not a regular file"}`,
      );
    }
    if (!realpathSync(tarball).startsWith(`${realDir}${sep}`)) {
      throw new Error(
        `${path}, the tarball ${file} names for ${name}, is ${realpathSync(tarball)}, outside ${realDir}`,
      );
    }
    const actual = integrityOf(tarball);
    if (actual !== release.tarball?.integrity) {
      throw new Error(
        `${path} is not the tarball ${file} names (integrity ${actual}, not ${String(release.tarball?.integrity)})`,
      );
    }
    const files = readTarball(tarball);
    const manifest = manifestOf(files);
    const packedName = stringAt(manifest, "name");
    const packedVersion = stringAt(manifest, "version");
    if (packedName !== name || packedVersion !== version) {
      throw new Error(
        `${path} holds ${String(packedName)}@${String(packedVersion)}, but its plan entry is ${name}@${version}`,
      );
    }
    return { name, version, path, file: tarball, manifest, files };
  });
  // Every entry below `dir` but its directories (a symlink to one is not one: readdir reports the
  // link itself), the plan and the planned tarballs.
  const others = (subdir: string): ReadonlyArray<string> =>
    readdirSync(join(dir, subdir), { withFileTypes: true }).flatMap((entry) => {
      const path = subdir === "" ? entry.name : `${subdir}/${entry.name}`;
      if (entry.isDirectory()) {
        return others(path);
      }
      return path === PUBLISH_PLAN || packed.some((release) => release.path === path)
        ? []
        : [entry.isSymbolicLink() ? `${path} (a symlink)` : path];
    });
  const stray = others("");
  if (stray.length > 0) {
    throw new Error(
      `${dir} holds what its plan does not publish (a pack output holds its plan and the planned tarballs only): ${stray.join(", ")}`,
    );
  }
  return packed;
};
