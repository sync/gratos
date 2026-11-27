// The dev loop (docs/plan.html M6 "Done when"), on the real `pnpm dev` process: node
// --watch-path over a copy of the app. A save restarts the server once, the boot step
// regenerates the schema, broken models answer GRATS_ERROR until the next good save, and each
// restart starts the APQ cache and open subscriptions over. Save-to-first-good-response is
// asserted within 10 s everywhere, and within the 2 s budget only when CI is unset; in CI the
// bench job reports it (support/budget.ts, docs/plan.html F3).
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { AUTHORIZATION, copyApp, devCommand, post, start, until } from "./support/app.ts";
import type { AppCopy, Answer, Payload, Running } from "./support/app.ts";
import { devLoopBounds, timingsReport } from "./support/budget.ts";
import type { DevLoopTiming } from "./support/budget.ts";

const BOUNDS = devLoopBounds(process.env);
/** Bounds for waits that are not measured against the budget (a first boot, a failure). */
const BOOT_MS = 15_000;

const MODEL = "src/models/Order.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const startDev = async (): Promise<{ readonly app: AppCopy; readonly dev: Running }> => {
  const app = copyApp();
  cleanups.push(app.remove);
  const { env, args } = devCommand();
  const dev = await start(app.dir, args, env);
  cleanups.push(dev.stop);
  return { app, dev };
};

const ORDER = { query: '{ order(id: "o-1") { id status } }' };
const LABEL = { query: '{ order(id: "o-1") { label } }' };

const dataOf = (answer: Answer | undefined, expected: unknown): Answer | undefined =>
  answer !== undefined &&
  answer.status === 200 &&
  JSON.stringify(answer.body) === JSON.stringify({ data: expected })
    ? answer
    : undefined;

/** The first good answer to `payload`, polled; fails with the process output after `timeoutMs`. */
const firstGood = (dev: Running, payload: Payload, expected: unknown, timeoutMs: number) =>
  until(async () => dataOf(await post(dev.url, payload), expected), {
    timeoutMs,
    message: `no good answer to ${JSON.stringify(payload)}`,
    app: dev,
  });

/** Writes `file` with `edit` applied, and returns the time of the save. */
const save = (app: AppCopy, file: string, edit: (source: string) => string): number => {
  const before = app.read(file);
  const after = edit(before);
  expect(after).not.toBe(before);
  const savedAt = performance.now();
  writeFileSync(app.path(file), after);
  return savedAt;
};

const LABEL_FIELD = `
  /** @gqlField */
  label(): string {
    return \`\${this.id}:\${this.status}\`;
  }

  constructor(row: OrderRow) {`;

const addLabel = (source: string) =>
  source.replace("\n  constructor(row: OrderRow) {", LABEL_FIELD);

/** The 1-based line of the first line of `source` that contains `text`. */
const lineOf = (source: string, text: string): number =>
  source.split("\n").findIndex((line) => line.includes(text)) + 1;

const timings: Array<DevLoopTiming> = [];

/** Records a save-to-first-good-response and asserts the bounds that apply here. */
const measured = (name: string, savedAt: number): void => {
  const ms = performance.now() - savedAt;
  timings.push({ name, ms: Math.round(ms) });
  expect(ms, `${name}: the correctness bound`).toBeLessThanOrEqual(BOUNDS.correctnessBoundMs);
  if (BOUNDS.latencyBudgetMs !== undefined) {
    expect(ms, `${name}: the latency budget`).toBeLessThanOrEqual(BOUNDS.latencyBudgetMs);
  }
};

afterAll(() => {
  // Written even when a test failed, so the bench job reports what was measured; the failure
  // still fails its step.
  if (BOUNDS.timingsFile !== undefined) {
    writeFileSync(BOUNDS.timingsFile, timingsReport(timings));
  }
});

describe("pnpm dev", () => {
  it("edits a model and sees the new field after one restart", async () => {
    const { app, dev } = await startDev();
    await firstGood(dev, ORDER, { order: { id: "o-1", status: "open" } }, BOOT_MS);
    expect(dev.output()).toContain("Gratos: the schema is up to date");
    expect(dev.restarts()).toBe(0);

    const savedAt = save(app, MODEL, addLabel);
    await firstGood(dev, LABEL, { order: { label: "o-1:open" } }, BOOT_MS);
    measured("edit → new field", savedAt);

    // The boot step wrote the generated files, which are not watched: no second restart.
    expect(app.read("src/generated/schema.graphql")).toContain("label: String");
    await sleep(500);
    expect(dev.restarts()).toBe(1);
    expect(dev.output()).toContain("Gratos: wrote generated/schema.graphql, generated/schema.ts");
  });

  it("breaks the model, answers GRATS_ERROR with the diagnostics, and recovers on the fix", async () => {
    const { app, dev } = await startDev();
    await firstGood(dev, ORDER, { order: { id: "o-1", status: "open" } }, BOOT_MS);

    // A type Grats cannot map to GraphQL.
    save(app, MODEL, (source) =>
      source.replace("  status: string;", "  status: Map<string, number>;"),
    );
    const broken = await until(
      async () => {
        const answer = await post(dev.url, ORDER);
        return answer?.status === 500 ? answer : undefined;
      },
      { timeoutMs: BOOT_MS, message: "no GRATS_ERROR", app: dev },
    );
    expect(broken.body).toEqual({
      errors: [
        {
          message: expect.stringContaining(
            "Gratos could not build the schema: Unable to resolve type reference.",
          ),
          extensions: {
            code: "GRATS_ERROR",
            diagnostics: [
              {
                message: expect.stringContaining("Unable to resolve type reference."),
                file: "src/models/Order.ts",
                line: lineOf(app.read(MODEL), "  status: Map<string, number>;"),
                column: 11,
              },
            ],
          },
        },
      ],
    });
    // Every request, whatever its method, until the next good save.
    const get = await fetch(`${dev.url}?query=${encodeURIComponent("{ __typename }")}`);
    expect(get.status).toBe(500);
    expect(get.headers.get("content-type")).toBe(
      "application/graphql-response+json; charset=utf-8",
    );
    expect(await get.json()).toMatchObject({ errors: [{ extensions: { code: "GRATS_ERROR" } }] });
    expect(dev.output()).toContain(
      "every request answers 500 GRATS_ERROR until the next good save",
    );

    // A syntax error: TypeScript's own diagnostic, through the same answer.
    save(app, MODEL, (source) =>
      source.replace("  status: Map<string, number>;", "  status: string = ;"),
    );
    await until(
      async () => {
        const answer = await post(dev.url, ORDER);
        return answer?.status === 500 && JSON.stringify(answer.body).includes("Expression expected")
          ? answer
          : undefined;
      },
      { timeoutMs: BOOT_MS, message: "no GRATS_ERROR for the syntax error", app: dev },
    );

    const fixedAt = save(app, MODEL, (source) =>
      source.replace("  status: string = ;", "  status: string;"),
    );
    await firstGood(dev, ORDER, { order: { id: "o-1", status: "open" } }, BOOT_MS);
    measured("fix → recovered", fixedAt);
    expect(dev.restarts()).toBe(3);
  });

  it("breaks a service, answers GRATS_ERROR on every path, and recovers on the fix", async () => {
    const { app, dev } = await startDev();
    await firstGood(dev, ORDER, { order: { id: "o-1", status: "open" } }, BOOT_MS);

    /** The first GRATS_ERROR answer whose body mentions `text`. */
    const gratsError = (text: string) =>
      until(
        async () => {
          const answer = await post(dev.url, ORDER);
          return answer?.status === 500 && JSON.stringify(answer.body).includes(text)
            ? answer
            : undefined;
        },
        { timeoutMs: BOOT_MS, message: `no GRATS_ERROR mentioning ${text}`, app: dev },
      );

    // A syntax error in a service the models import.
    save(app, "src/services/Bus.ts", (source) =>
      source.replace("PubSub.unbounded<Event>();", "PubSub.unbounded<Event>(;"),
    );
    const syntax = await gratsError("Expression expected");
    expect(syntax.body).toEqual({
      errors: [
        {
          message:
            "Gratos could not load the app: SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expression expected",
          extensions: {
            code: "GRATS_ERROR",
            diagnostics: [
              {
                message: "SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expression expected",
                file: "src/services/Bus.ts",
                line: lineOf(app.read("src/services/Bus.ts"), "PubSub.unbounded<Event>(;"),
              },
            ],
          },
        },
      ],
    });
    // The terminal shows Node's report, with the source line.
    expect(dev.output()).toContain("PubSub.unbounded<Event>(;");

    // Every request answers it, on any path, not only /graphql.
    const other = await fetch(new URL("/health", dev.url));
    expect(other.status).toBe(500);
    expect(await other.json()).toMatchObject({
      errors: [{ extensions: { code: "GRATS_ERROR" } }],
    });
    // Even a path a router could not decode (the failure is served with no router at all).
    const undecodable = await fetch(`${new URL(dev.url).origin}/%FF`, { method: "DELETE" });
    expect(undecodable.status).toBe(500);
    expect(await undecodable.json()).toMatchObject({
      errors: [{ extensions: { code: "GRATS_ERROR" } }],
    });

    // A service only the app's wiring imports, which builds but throws when it is loaded.
    save(app, "src/services/Bus.ts", (source) =>
      source.replace("PubSub.unbounded<Event>(;", "PubSub.unbounded<Event>();"),
    );
    save(
      app,
      "src/services/FakeApi.ts",
      (source) => `${source}\nthrow new Error("FakeApi is broken");\n`,
    );
    const thrown = await gratsError("FakeApi is broken");
    expect(thrown.body).toEqual({
      errors: [
        {
          message: "Gratos could not load the app: Error: FakeApi is broken",
          extensions: {
            code: "GRATS_ERROR",
            diagnostics: [{ message: "Error: FakeApi is broken" }],
          },
        },
      ],
    });

    const fixedAt = save(app, "src/services/FakeApi.ts", (source) =>
      source.replace('\nthrow new Error("FakeApi is broken");\n', ""),
    );
    await firstGood(dev, ORDER, { order: { id: "o-1", status: "open" } }, BOOT_MS);
    measured("service fix → recovered", fixedAt);
  });

  it("starts the APQ cache and open subscriptions over on each save", async () => {
    const { app, dev } = await startDev();
    await firstGood(dev, ORDER, { order: { id: "o-1", status: "open" } }, BOOT_MS);

    // Register the query under its hash, then answer the hash alone from the cache.
    const query = ORDER.query;
    const sha256Hash = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(query)),
    ).toString("hex");
    const persisted = { extensions: { persistedQuery: { version: 1, sha256Hash } } };
    expect(
      dataOf(await post(dev.url, { query, ...persisted }), {
        order: { id: "o-1", status: "open" },
      }),
    ).toBeDefined();
    expect(
      dataOf(await post(dev.url, persisted), { order: { id: "o-1", status: "open" } }),
    ).toBeDefined();

    // An open subscription, which has received an event: the core answers with the first one,
    // the order as it is.
    const opened = await fetch(dev.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: AUTHORIZATION,
      },
      body: JSON.stringify({ query: 'subscription { orderChanged(id: "o-2") { status } }' }),
      signal: AbortSignal.timeout(BOOT_MS),
    });
    expect(opened.status).toBe(200);
    expect(opened.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = opened.body?.getReader();
    if (reader === undefined) {
      throw new Error("the subscription has no body");
    }
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('"status":"shipped"');
    const ended = (async () => {
      try {
        while (!(await reader.read()).done) {
          // Drain until the old process drops the connection.
        }
      } catch {
        // A dropped connection.
      }
      return performance.now();
    })();

    // A change to the fake backend's in-memory rows, which the restart must undo.
    expect(
      dataOf(await post(dev.url, { query: 'mutation { cancelOrder(id: "o-1") { status } }' }), {
        cancelOrder: { status: "cancelled" },
      }),
    ).toBeDefined();
    expect(
      dataOf(await post(dev.url, ORDER), { order: { id: "o-1", status: "cancelled" } }),
    ).toBeDefined();

    // A save that changes no schema: the restart alone starts everything over.
    const savedAt = save(app, MODEL, (source) => `${source}\n// saved\n`);
    // The subscription is dropped promptly (not after the 20 s graceful-shutdown default), and
    // the new process answers within the budget although a subscription was open. The old
    // process answers this query too until it stops (o-1 cancelled): wait for the new one to
    // listen, and to answer with o-1 open.
    await until(async () => (dev.boots() === 2 ? true : undefined), {
      timeoutMs: BOOT_MS,
      message: "the server never restarted",
      app: dev,
    });
    await firstGood(dev, ORDER, { order: { id: "o-1", status: "open" } }, BOOT_MS);
    measured("save with an open subscription → answered", savedAt);
    const endedAt = await Promise.race([ended, sleep(1000, undefined)]);
    expect(endedAt).toBeDefined();
    expect(dev.output()).toContain("Gratos: the schema is up to date");

    // The new process has an empty APQ cache: the hash alone is not found.
    expect(await post(dev.url, persisted)).toMatchObject({
      body: { errors: [{ extensions: { code: "PERSISTED_QUERY_NOT_FOUND" } }] },
    });
    // The new process starts from the fake API's initial rows: the order cancelled before the
    // save is open again, and the shipped one is still shipped.
    expect(
      dataOf(await post(dev.url, ORDER), { order: { id: "o-1", status: "open" } }),
    ).toBeDefined();
    expect(
      dataOf(await post(dev.url, { query: '{ order(id: "o-2") { status } }' }), {
        order: { status: "shipped" },
      }),
    ).toBeDefined();
    expect(dev.restarts()).toBe(1);
  });

  it("reports its timings", () => {
    // oxlint-disable-next-line no-console
    console.log(
      `dev-loop timings (${
        BOUNDS.latencyBudgetMs === undefined
          ? "CI: reported, not asserted"
          : `budget ${BOUNDS.latencyBudgetMs} ms`
      }; correctness bound ${BOUNDS.correctnessBoundMs} ms):\n  ${timings
        .map(({ name, ms }) => `${name}: ${ms} ms`)
        .join("\n  ")}`,
    );
    expect(timings.length).toBeGreaterThan(0);
  });
});
