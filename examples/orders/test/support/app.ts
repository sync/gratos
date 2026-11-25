// Runs the orders app as real processes for the dev-loop tests (docs/plan.html M6): a copy of
// src/ in a temporary directory (so edits never touch the checkout, and concurrent tasks such as
// codegen:check never see them), started with the exact `pnpm dev` command, and killed with its
// whole process group (the watcher, the server it restarts, tsgo) on every path.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const exampleDir = join(import.meta.dirname, "..", "..");

/** The `dev` script, as the tests run it: an env assignment, then node and its arguments. */
export const DEV_SCRIPT =
  "GRATS_DEV=1 node --watch-path=src/models --watch-path=src/services --watch-preserve-output src/server.ts";

export interface DevCommand {
  readonly env: Record<string, string>;
  readonly args: Array<string>;
}

/** The `dev` script of package.json, split into its env assignment and node's arguments. */
export const devCommand = (): DevCommand => {
  const parsed: unknown = JSON.parse(readFileSync(join(exampleDir, "package.json"), "utf8"));
  const scripts =
    typeof parsed === "object" && parsed !== null && "scripts" in parsed ? parsed.scripts : {};
  const script =
    typeof scripts === "object" && scripts !== null && "dev" in scripts ? scripts.dev : undefined;
  if (script !== DEV_SCRIPT) {
    throw new Error(`examples/orders' dev script is ${String(script)}, not ${DEV_SCRIPT}`);
  }
  const [assignment = "", node, ...args] = script.split(" ");
  const [name = "", value = ""] = assignment.split("=");
  if (node !== "node") {
    throw new Error(`the dev script runs ${String(node)}, not node`);
  }
  return { env: { [name]: value }, args };
};

export interface AppCopy {
  readonly dir: string;
  readonly path: (relativePath: string) => string;
  readonly read: (relativePath: string) => string;
  readonly remove: () => void;
}

/** A copy of the app's src/ and package.json, resolving its dependencies through the example's. */
export const copyApp = (): AppCopy => {
  // The real path: macOS's tmpdir is a symlink, and the watcher reports real paths.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gratos-orders-")));
  cpSync(join(exampleDir, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(exampleDir, "package.json"), join(dir, "package.json"));
  symlinkSync(join(exampleDir, "node_modules"), join(dir, "node_modules"), "dir");
  const path = (relativePath: string) => join(dir, relativePath);
  return {
    dir,
    path,
    read: (relativePath) => readFileSync(path(relativePath), "utf8"),
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

/** A port that was free a moment ago (the app binds it itself, across restarts). */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

export interface Running {
  readonly url: string;
  /** Everything the process tree wrote to stdout and stderr so far. */
  readonly output: () => string;
  /** How many times the watcher restarted the server so far. */
  readonly restarts: () => number;
  /** How many server processes have started listening so far. */
  readonly boots: () => number;
  /** Stops the process tree (SIGTERM, then SIGKILL) and waits for the watcher to exit. */
  readonly stop: () => Promise<void>;
  readonly exited: Promise<number | null>;
}

/** Spawns node with `args` in `cwd` (its own process group), listening on PORT. */
export const start = async (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Promise<Running> => {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1", NO_COLOR: "1" },
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, signal);
      }
    } catch {
      // The group is gone already.
    }
  };
  const stop = async () => {
    killGroup("SIGTERM");
    const timer = setTimeout(() => killGroup("SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
    // The server restarted by the watcher, or tsgo, may outlive the watcher: kill what is left.
    killGroup("SIGKILL");
  };
  return {
    url: `http://127.0.0.1:${port}/graphql`,
    output: () => output,
    restarts: () => output.split("Restarting 'src/server.ts'").length - 1,
    boots: () => output.split("Listening on http://").length - 1,
    stop,
    exited,
  };
};

/** A GraphQL-over-HTTP request body. */
export interface Payload {
  readonly query?: string;
  readonly extensions?: {
    readonly persistedQuery: { readonly version: number; readonly sha256Hash: string };
  };
}

export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** POSTs a GraphQL request; a connection error (the server is restarting) is undefined. */
export const post = async (url: string, payload: Payload): Promise<Answer | undefined> => {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/graphql-response+json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    });
    return { status: response.status, body: await response.json() };
  } catch {
    return undefined;
  }
};

/**
 * Polls `probe` every 20 ms until it returns a value, failing with `message` (and the process
 * output) after `timeoutMs`.
 */
export const until = async <A>(
  probe: () => Promise<A | undefined>,
  options: { readonly timeoutMs: number; readonly message: string; readonly app?: Running },
): Promise<A> => {
  const deadline = performance.now() + options.timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (performance.now() > deadline) {
      const output =
        options.app === undefined ? "" : `\n--- process output ---\n${options.app.output()}`;
      throw new Error(`Timed out after ${options.timeoutMs} ms: ${options.message}${output}`);
    }
    await sleep(20);
  }
};
